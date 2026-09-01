import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { requirePayment, settleQuietly, withPaymentReceipt } from "@/lib/payments/x402";
import { VEO_DEFAULT_DURATION_SECONDS } from "@/lib/pricing/costs";
import { withJob } from "@/lib/jobs";
import { extractStructuredPrompt } from "@/lib/clients/anthropic";
import * as veo from "@/lib/clients/veo";
import * as gemini from "@/lib/clients/gemini";
import { getBrandKit, applyBrandConstraintsToPrompt } from "@/lib/brand-kit";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z
  .object({
    buyer_wallet: z.string().optional(),
    media_url: z.string().url().optional(),
    prompt: z.string().optional(),
    output_type: z.enum(["image", "video"]).default("image"),
    brand_kit_id: z.string().uuid().optional()
  })
  .refine((v) => v.media_url || v.prompt, { message: "media_url or prompt is required" });

/**
 * S1: Image/Video <-> Text Prompting.
 * media in -> structured, reusable prompt (via Claude vision).
 * text in, image out -> Gemini (gemini-2.5-flash-image / "Nano Banana").
 * text in, video out -> Google Veo (see lib/clients/veo.ts for pricing and
 * a polling-timeout risk on Vercel worth reading before relying on this).
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    // Verify payment before spending anything downstream; settle only
    // after the job succeeds. The claimed wallet is passed in so any
    // credit balance it holds reduces what has to be paid on-chain --
    // honoured only if that same wallet turns out to have signed.
    const claimedWallet = req.headers.get("x-buyer-wallet") ?? body.buyer_wallet ?? null;

    // S1 has three paths with wildly different costs behind one price.
    // Prompt extraction and image generation fit the flat $0.05; text ->
    // video runs Veo, which costs ~24x that, so it is billed at S2's
    // per-second rate instead. `lib/clients/veo.ts` defaults to 6s when no
    // duration is given, which is what this path does.
    const generatesVideo = !body.media_url && body.output_type === "video";
    const payment = await requirePayment(req, {
      serviceType: "s1_prompt_bridge",
      priceAs: generatesVideo ? "s2_image_to_motion" : undefined,
      quantity: generatesVideo ? VEO_DEFAULT_DURATION_SECONDS : 1,
      buyerWallet: claimedWallet
    });
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet, payment.payer);
    const pricing = getToolDefinition("s1_prompt_bridge")!.pricing;

    const { job_id, output } = await withJob(
      {
        serviceType: "s1_prompt_bridge",
        buyerWallet,
        input: body,
        payment
      },
      async (jobId) => {
        const supabase = getSupabaseAdmin();

        if (body.media_url) {
          const fields = await extractStructuredPrompt(body.media_url);
          await supabase.from("media_assets").insert({
            job_id: jobId,
            type: "prompt",
            url: body.media_url,
            source_prompt: null,
            metadata: fields,
            brand_kit_id: body.brand_kit_id ?? null,
            qc_status: "pass"
          });
          return { mode: "media_to_prompt" as const, prompt_fields: fields };
        }

        const kit = body.brand_kit_id ? await getBrandKit(body.brand_kit_id) : null;
        const finalPrompt = applyBrandConstraintsToPrompt(body.prompt!, kit);

        const assetUrl =
          body.output_type === "video"
            ? (await veo.generateVideo({ prompt: finalPrompt })).url
            : (await gemini.generateImage({ prompt: finalPrompt })).assets[0]?.url ?? null;

        await supabase.from("media_assets").insert({
          job_id: jobId,
          type: body.output_type,
          url: assetUrl,
          source_prompt: finalPrompt,
          metadata: {},
          brand_kit_id: body.brand_kit_id ?? null,
          qc_status: "pending"
        });

        return { mode: "text_to_media" as const, asset_url: assetUrl };
      }
    );

    const receipt = await settleQuietly(payment);
    return withPaymentReceipt(
      NextResponse.json({ job_id, price: pricing, payment: receipt, ...output }),
      receipt
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
