import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { requirePayment, settleQuietly, withPaymentReceipt } from "@/lib/payments/x402";
import { withJob } from "@/lib/jobs";
import * as gemini from "@/lib/clients/gemini";
import { getBrandKit, applyBrandConstraintsToPrompt } from "@/lib/brand-kit";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  description: z.string().min(1),
  style_reference_url: z.string().url().optional(),
  collection_theme: z.string().optional(),
  count: z.number().int().min(1).max(100),
  brand_kit_id: z.string().uuid().optional()
});

/**
 * S6: NFT image generation from a buyer description. Enforces a consistent
 * art style across the whole order by folding collection_theme + brand kit
 * into every prompt. No hard duplication guarantee at this tier -- that's
 * S10's job.
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    // Verify payment before spending anything downstream; settle only
    // after the job succeeds. The claimed wallet is passed in so any
    // credit balance it holds reduces what has to be paid on-chain --
    // honoured only if that same wallet turns out to have signed.
    const claimedWallet = req.headers.get("x-buyer-wallet") ?? body.buyer_wallet ?? null;
    const payment = await requirePayment(req, {
      serviceType: "s6_nft_image_gen",
      quantity: body.count,
      buyerWallet: claimedWallet
    });
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet, payment.payer);
    const pricing = getToolDefinition("s6_nft_image_gen")!.pricing;

    const { job_id, output } = await withJob(
      {
        serviceType: "s6_nft_image_gen",
        buyerWallet,
        input: body,
        payment
      },
      async (jobId) => {
        const supabase = getSupabaseAdmin();
        const kit = body.brand_kit_id ? await getBrandKit(body.brand_kit_id) : null;

        const basePrompt = body.collection_theme
          ? `${body.description}. Collection theme: ${body.collection_theme}.`
          : body.description;
        const finalPrompt = applyBrandConstraintsToPrompt(basePrompt, kit);

        const generations = await Promise.all(
          Array.from({ length: body.count }, () =>
            gemini.generateImage({
              prompt: finalPrompt,
              medias: body.style_reference_url
                ? [{ value: body.style_reference_url, role: "style_reference" }]
                : undefined
            })
          )
        );

        const assets = generations.map((g) => ({ url: g.assets[0]?.url ?? null, generation_job_id: g.job_id }));

        await supabase.from("media_assets").insert(
          assets.map((asset) => ({
            job_id: jobId,
            type: "image" as const,
            url: asset.url,
            source_prompt: finalPrompt,
            metadata: { generation_job_id: asset.generation_job_id },
            brand_kit_id: body.brand_kit_id ?? null,
            qc_status: "pending" as const
          }))
        );

        return { assets };
      }
    );

    // Charged for the requested count; credit back anything not delivered.
    await payment.reconcile(output.assets.filter((a) => a.url).length, job_id);
    const receipt = await settleQuietly(payment);
    return withPaymentReceipt(
      NextResponse.json({ job_id, price: pricing, payment: receipt, ...output }),
      receipt
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
