import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { withJob } from "@/lib/jobs";
import * as higgsfield from "@/lib/clients/higgsfield";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  image_url: z.string().url(),
  motion_description: z.string().optional(),
  max_duration_seconds: z.number().int().positive().max(10).default(5),
  resolution: z.enum(["720p", "1080p"]).default("720p")
});

/**
 * S2: Video motion from a single image. Duration/resolution are capped in
 * the schema so pricing stays predictable regardless of buyer input.
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet);
    const pricing = getToolDefinition("s2_image_to_motion")!.pricing;

    const { job_id, output } = await withJob(
      { serviceType: "s2_image_to_motion", buyerWallet, input: body },
      async (jobId) => {
        const result = body.motion_description
          ? await higgsfield.generateVideo({
              prompt: body.motion_description,
              durationSeconds: body.max_duration_seconds,
              medias: [{ value: body.image_url, role: "start_image" }]
            })
          : await higgsfield.motionControl({
              imageId: body.image_url,
              resolution: body.resolution
            });

        const videoUrl = result.assets[0]?.url ?? null;
        const supabase = getSupabaseAdmin();
        await supabase.from("media_assets").insert({
          job_id: jobId,
          type: "video",
          url: videoUrl,
          source_prompt: body.motion_description ?? null,
          metadata: { source_image_url: body.image_url, higgsfield_job_id: result.job_id },
          qc_status: "pending"
        });

        return { video_url: videoUrl, duration_seconds: result.assets[0]?.duration_seconds ?? body.max_duration_seconds };
      }
    );

    return NextResponse.json({ job_id, price: pricing, ...output });
  } catch (err) {
    return handleRouteError(err);
  }
}
