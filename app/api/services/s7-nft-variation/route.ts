import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { withJob } from "@/lib/jobs";
import * as fal from "@/lib/clients/fal";
import { similarityScore } from "@/lib/image-similarity";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  source_image_url: z.string().url(),
  variation_count: z.number().int().min(1).max(50),
  strength: z.number().min(0).max(1).default(0.5)
});

/**
 * S7: NFT variation from a single source image. Each variation gets a
 * per-image similarity score against the source so the buyer can judge
 * diversity without eyeballing it.
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet);
    const pricing = getToolDefinition("s7_nft_variation")!.pricing;

    const { job_id, output } = await withJob(
      { serviceType: "s7_nft_variation", buyerWallet, input: body },
      async (jobId) => {
        const supabase = getSupabaseAdmin();

        // Real img2img with a strength dial, via Qwen-Image on fal.ai --
        // Gemini (used elsewhere in this suite) has no equivalent
        // mechanism. body.strength maps directly to the model's denoising
        // strength (0 = preserve original, 1 = fully remake).
        const variationPrompt =
          "Create a variation of this image: keep the overall subject and composition recognizable, but vary details such as color, pose, or background.";

        const generations = await Promise.all(
          Array.from({ length: body.variation_count }, () =>
            fal.qwenImageToImage({
              imageUrl: body.source_image_url,
              prompt: variationPrompt,
              strength: body.strength
            })
          )
        );

        const variations = await Promise.all(
          generations.map(async (g) => {
            const score = await similarityScore(body.source_image_url, g.url);
            return { url: g.url, similarity_score: score };
          })
        );

        await supabase.from("media_assets").insert(
          variations.map((v) => ({
            job_id: jobId,
            type: "image" as const,
            url: v.url,
            source_prompt: variationPrompt,
            metadata: { source_image_url: body.source_image_url, similarity_score: v.similarity_score, strength: body.strength },
            qc_status: "pending" as const
          }))
        );

        return { variations };
      }
    );

    return NextResponse.json({ job_id, price: pricing, ...output });
  } catch (err) {
    return handleRouteError(err);
  }
}
