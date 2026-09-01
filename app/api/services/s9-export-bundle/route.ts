import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { requirePayment, settleQuietly, withPaymentReceipt } from "@/lib/payments/x402";
import { withJob } from "@/lib/jobs";
import { buildExportBundle } from "@/lib/export-bundle";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  source_asset_url: z.string().url(),
  targets: z.array(z.enum(["marketplace", "social", "print", "web"])).default(["marketplace", "social", "web"]),
  marketplace: z.string().optional(),
  nft_metadata: z
    .object({
      name: z.string(),
      description: z.string(),
      attributes: z.array(z.object({ trait_type: z.string(), value: z.string() })).default([])
    })
    .optional()
});

/**
 * S9: NFT-ready multi-format export. Shared post-processing step -- any
 * NFT-facing service (S6, S7, S10) can call this with its output asset
 * instead of re-generating per target.
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    // Verify payment before spending anything downstream; settle only
    // after the job succeeds.
    const payment = await requirePayment(req, { serviceType: "s9_export_bundle", quantity: 1 });
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet, payment.payer);
    const pricing = getToolDefinition("s9_export_bundle")!.pricing;

    const { job_id, output } = await withJob(
      {
        serviceType: "s9_export_bundle",
        buyerWallet,
        input: body,
        pricePaid: payment.amount,
        priceCurrency: payment.currency
      },
      async (jobId) => {
        const supabase = getSupabaseAdmin();

        const { data: mediaAsset, error } = await supabase
          .from("media_assets")
          .insert({
            job_id: jobId,
            type: "image",
            url: body.source_asset_url,
            source_prompt: null,
            metadata: { role: "export_source" },
            qc_status: "pass"
          })
          .select()
          .single();
        if (error || !mediaAsset) throw new Error(`Failed to record source asset: ${error?.message}`);

        const { manifest } = await buildExportBundle({
          sourceAssetUrl: body.source_asset_url,
          mediaAssetId: mediaAsset.id,
          targets: body.targets,
          marketplace: body.marketplace,
          nftMetadataBase: body.nft_metadata
        });

        const manifestJson = JSON.stringify({ source: body.source_asset_url, manifest }, null, 2);
        const manifestPath = `exports/${mediaAsset.id}/manifest.json`;
        await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets").upload(
          manifestPath,
          manifestJson,
          { contentType: "application/json", upsert: true }
        );
        const { data: manifestUrlData } = supabase.storage
          .from(process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets")
          .getPublicUrl(manifestPath);

        return {
          manifest_url: manifestUrlData.publicUrl,
          bundle: manifest.map((m) => ({ target: m.target, file_url: m.fileUrl }))
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
