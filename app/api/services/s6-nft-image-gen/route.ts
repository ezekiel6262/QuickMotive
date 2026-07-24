import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { withJob } from "@/lib/jobs";
import * as higgsfield from "@/lib/clients/higgsfield";
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
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet);
    const pricing = getToolDefinition("s6_nft_image_gen")!.pricing;

    const { job_id, output } = await withJob(
      { serviceType: "s6_nft_image_gen", buyerWallet, input: body },
      async (jobId) => {
        const supabase = getSupabaseAdmin();
        const kit = body.brand_kit_id ? await getBrandKit(body.brand_kit_id) : null;

        const basePrompt = body.collection_theme
          ? `${body.description}. Collection theme: ${body.collection_theme}.`
          : body.description;
        const finalPrompt = applyBrandConstraintsToPrompt(basePrompt, kit);

        const generations = await Promise.all(
          Array.from({ length: body.count }, () =>
            higgsfield.generateImage({
              model: "nano_banana_pro",
              prompt: finalPrompt,
              medias: body.style_reference_url
                ? [{ value: body.style_reference_url, role: "style_reference" }]
                : undefined
            })
          )
        );

        const assets = generations.map((g) => ({ url: g.assets[0]?.url ?? null, higgsfield_job_id: g.job_id }));

        await supabase.from("media_assets").insert(
          assets.map((asset) => ({
            job_id: jobId,
            type: "image" as const,
            url: asset.url,
            source_prompt: finalPrompt,
            metadata: { higgsfield_job_id: asset.higgsfield_job_id },
            brand_kit_id: body.brand_kit_id ?? null,
            qc_status: "pending" as const
          }))
        );

        return { assets };
      }
    );

    return NextResponse.json({ job_id, price: pricing, ...output });
  } catch (err) {
    return handleRouteError(err);
  }
}
