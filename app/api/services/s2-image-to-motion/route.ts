import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { requirePayment, settleQuietly, withPaymentReceipt } from "@/lib/payments/x402";
import { withJob } from "@/lib/jobs";
import * as veo from "@/lib/clients/veo";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { getToolDefinition } from "@/lib/a2mcp/registry";

// Veo's poll loop (lib/clients/veo.ts) can take up to ~2 minutes; without
// this, Vercel's default function timeout kills the request first, wasting
// the Veo charge on a call whose result never reaches the caller.
export const maxDuration = 120;

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  image_url: z.string().url(),
  motion_description: z.string().optional(),
  // Veo 3.1 only accepts 4, 6, or 8 seconds -- not an arbitrary integer.
  max_duration_seconds: z.union([z.literal(4), z.literal(6), z.literal(8)]).default(6),
  resolution: z.enum(["720p", "1080p"]).default("720p")
});

/**
 * S2: Video motion from a single image, via Google Veo (Gemini API).
 * Duration/resolution are capped in the schema so pricing stays
 * predictable regardless of buyer input -- see lib/clients/veo.ts for the
 * real per-second cost this maps to and the polling-timeout risk on
 * Vercel.
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
      serviceType: "s2_image_to_motion",
      quantity: body.max_duration_seconds,
      buyerWallet: claimedWallet
    });
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet, payment.payer);
    const pricing = getToolDefinition("s2_image_to_motion")!.pricing;

    const { job_id, output } = await withJob(
      {
        serviceType: "s2_image_to_motion",
        buyerWallet,
        input: body,
        payment
      },
      async (jobId) => {
        const result = await veo.generateVideo({
          imageUrl: body.image_url,
          prompt: body.motion_description,
          durationSeconds: body.max_duration_seconds,
          resolution: body.resolution
        });

        const supabase = getSupabaseAdmin();
        await supabase.from("media_assets").insert({
          job_id: jobId,
          type: "video",
          url: result.url,
          source_prompt: body.motion_description ?? null,
          metadata: { source_image_url: body.image_url },
          qc_status: "pending"
        });

        return { video_url: result.url, duration_seconds: result.durationSeconds };
      }
    );

    // Charged for the requested count; credit back anything not delivered.
    await payment.reconcile(output.duration_seconds, job_id);
    const receipt = await settleQuietly(payment);
    return withPaymentReceipt(
      NextResponse.json({ job_id, price: pricing, payment: receipt, ...output }),
      receipt
    );
  } catch (err) {
    return handleRouteError(err);
  }
}
