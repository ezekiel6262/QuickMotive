import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
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
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet);
    const pricing = getToolDefinition("s1_prompt_bridge")!.pricing;

    const { job_id, output } = await withJob(
      { serviceType: "s1_prompt_bridge", buyerWallet, input: body },
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

    return NextResponse.json({ job_id, price: pricing, ...output });
  } catch (err) {
    return handleRouteError(err);
  }
}
