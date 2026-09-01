import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { requirePayment, settleQuietly, withPaymentReceipt } from "@/lib/payments/x402";
import { withJob } from "@/lib/jobs";
import { upsertBrandKit } from "@/lib/brand-kit";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  brand_kit_id: z.string().uuid().optional(),
  name: z.string().min(1),
  palette: z.array(z.object({ hex: z.string(), role: z.string() })).default([]),
  typography: z.record(z.unknown()).default({}),
  logo_urls: z.array(z.string().url()).default([]),
  style_ref_urls: z.array(z.string().url()).default([]),
  tone_descriptors: z.string().optional()
});

/**
 * S5: Brand-lock kit definition. Persists once per buyer, referenced by
 * `brand_kit_id` from S1/S6/S7/S8/S10 generation calls thereafter.
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    // Verify payment before spending anything downstream; settle only
    // after the job succeeds.
    const payment = await requirePayment(req, { serviceType: "s5_brand_kit", quantity: 1 });
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet, payment.payer);
    const pricing = getToolDefinition("s5_brand_kit")!.pricing;

    const { job_id, output } = await withJob(
      {
        serviceType: "s5_brand_kit",
        buyerWallet,
        input: body,
        pricePaid: payment.amount,
        priceCurrency: payment.currency
      },
      async () => {
        const kit = await upsertBrandKit({
          buyerWallet,
          brandKitId: body.brand_kit_id,
          name: body.name,
          palette: body.palette,
          typography: body.typography,
          logoUrls: body.logo_urls,
          styleRefUrls: body.style_ref_urls,
          toneDescriptors: body.tone_descriptors
        });
        return { brand_kit_id: kit.id };
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
