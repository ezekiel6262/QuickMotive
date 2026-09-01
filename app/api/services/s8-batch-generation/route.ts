import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { requirePayment, settleQuietly, withPaymentReceipt } from "@/lib/payments/x402";
import { withJob } from "@/lib/jobs";
import * as gemini from "@/lib/clients/gemini";
import { getBrandKit, applyBrandConstraintsToPrompt } from "@/lib/brand-kit";
import { runQcCheck } from "@/lib/qc";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  brief: z.string().min(1),
  count: z.number().int().min(1).max(200),
  brand_kit_id: z.string().uuid().optional(),
  target_aspect_ratio: z.string().default("1:1"),
  regenerate_once_on_flag: z.boolean().default(true)
});

interface GeneratedItem {
  url: string;
  generationJobId: string;
}

async function generateOne(prompt: string, aspectRatio: string): Promise<GeneratedItem> {
  const result = await gemini.generateImage({ prompt, aspectRatio });
  const url = result.assets[0]?.url;
  if (!url) throw new Error("Generation returned no asset");
  return { url, generationJobId: result.job_id };
}

/**
 * S8: Batch generation with QC gating. Fans out N generations in parallel
 * (not sequential), auto-flags failures against aspect ratio / brand
 * palette, optionally regenerates flagged items once, and returns a
 * passing set plus a separate flagged set with reasons.
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    // Verify payment before spending anything downstream; settle only
    // after the job succeeds.
    const payment = await requirePayment(req, { serviceType: "s8_batch_generation", quantity: body.count });
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet, payment.payer);
    const pricing = getToolDefinition("s8_batch_generation")!.pricing;

    const { job_id, output } = await withJob(
      {
        serviceType: "s8_batch_generation",
        buyerWallet,
        input: body,
        pricePaid: payment.amount,
        priceCurrency: payment.currency
      },
      async (jobId) => {
        const supabase = getSupabaseAdmin();
        const kit = body.brand_kit_id ? await getBrandKit(body.brand_kit_id) : null;
        const prompt = applyBrandConstraintsToPrompt(body.brief, kit);

        const initial = await Promise.all(
          Array.from({ length: body.count }, () => generateOne(prompt, body.target_aspect_ratio))
        );

        const checked = await Promise.all(
          initial.map(async (item) => ({
            item,
            qc: await runQcCheck({ imageUrl: item.url, targetAspectRatio: body.target_aspect_ratio, brandKit: kit })
          }))
        );

        const passing: GeneratedItem[] = [];
        const flagged: Array<{ url: string; reasons: string[] }> = [];

        for (const { item, qc } of checked) {
          if (qc.pass) {
            passing.push(item);
            continue;
          }

          if (body.regenerate_once_on_flag) {
            const retry = await generateOne(prompt, body.target_aspect_ratio);
            const retryQc = await runQcCheck({ imageUrl: retry.url, targetAspectRatio: body.target_aspect_ratio, brandKit: kit });
            if (retryQc.pass) {
              passing.push(retry);
              continue;
            }
            flagged.push({ url: retry.url, reasons: retryQc.reasons });
          } else {
            flagged.push({ url: item.url, reasons: qc.reasons });
          }
        }

        await supabase.from("media_assets").insert([
          ...passing.map((p) => ({
            job_id: jobId,
            type: "image" as const,
            url: p.url,
            source_prompt: prompt,
            metadata: { generation_job_id: p.generationJobId },
            brand_kit_id: body.brand_kit_id ?? null,
            qc_status: "pass" as const
          })),
          ...flagged.map((f) => ({
            job_id: jobId,
            type: "image" as const,
            url: f.url,
            source_prompt: prompt,
            metadata: {},
            brand_kit_id: body.brand_kit_id ?? null,
            qc_status: "flagged" as const,
            qc_reason: f.reasons.join("; ")
          }))
        ]);

        return { passing, flagged };
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
