import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError, ApiError } from "@/lib/api-helpers";
import { requirePayment, settleQuietly, withPaymentReceipt } from "@/lib/payments/x402";
import { withJob } from "@/lib/jobs";
import * as canva from "@/lib/clients/canva";
import * as stability from "@/lib/clients/stability";
import { planEditOperations } from "@/lib/clients/anthropic";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { getToolDefinition } from "@/lib/a2mcp/registry";
import type { EditOperation } from "@/lib/clients/canva";

const bodySchema = z
  .object({
    buyer_wallet: z.string().optional(),
    canva_design_id: z.string().optional(),
    design_import_url: z.string().url().optional(),
    raster_image_url: z.string().url().optional(),
    instruction: z.string().min(1)
  })
  .refine((v) => v.canva_design_id || v.design_import_url || v.raster_image_url, {
    message: "one of canva_design_id, design_import_url, or raster_image_url is required"
  });

/**
 * S3: Graphic design smart edit. Canva designs go through the
 * read-design -> edit-design -> commit -> export transaction flow;
 * non-Canva raster assets get a non-destructive region edit via Stability
 * AI (background cutout -> inverted-alpha mask -> inpaint) so only the
 * background changes and the foreground subject stays pixel-identical.
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
      serviceType: "s3_design_tweak",
      quantity: 1,
      buyerWallet: claimedWallet
    });
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet, payment.payer);
    const pricing = getToolDefinition("s3_design_tweak")!.pricing;

    const { job_id, output } = await withJob(
      {
        serviceType: "s3_design_tweak",
        buyerWallet,
        input: body,
        payment
      },
      async (jobId) => {
        const supabase = getSupabaseAdmin();

        if (body.raster_image_url) {
          const result = await stability.editBackgroundRegion({
            imageUrl: body.raster_image_url,
            instruction: body.instruction
          });
          const url = result.url;
          await supabase.from("media_assets").insert({
            job_id: jobId,
            type: "image",
            url,
            source_prompt: body.instruction,
            metadata: { source_image_url: body.raster_image_url, edit_kind: "raster_region_edit" },
            qc_status: "pending"
          });
          return { exported_file_url: url, canva_design_url: null };
        }

        let designId = body.canva_design_id;
        if (!designId && body.design_import_url) {
          const imported = await canva.importDesignFromUrl({
            url: body.design_import_url,
            name: `QuickMotive import ${jobId}`
          });
          designId = imported.design_id;
        }
        if (!designId) throw new ApiError(422, "Could not resolve a Canva design to edit");

        const doc = await canva.readDesign(designId);
        const firstPage = doc.pages[0];
        if (!firstPage) throw new ApiError(422, "Design has no editable pages");

        const operations = (await planEditOperations({
          instruction: body.instruction,
          elements: firstPage.elements
        })) as EditOperation[];

        await canva.applyEditOperations({
          transactionId: doc.transaction_id,
          pageIndex: firstPage.page_index,
          operations
        });
        await canva.commitTransaction(doc.transaction_id);

        const exported = await canva.exportDesign({ designId, format: { type: "png", export_quality: "regular" } });

        await supabase.from("media_assets").insert({
          job_id: jobId,
          type: "design_export",
          url: exported.export_url,
          source_prompt: body.instruction,
          metadata: { canva_design_id: designId, operations },
          qc_status: "pass"
        });

        return {
          exported_file_url: exported.export_url,
          canva_design_url: `https://www.canva.com/design/${designId}/view`
        };
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
