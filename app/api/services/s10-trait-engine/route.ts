import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError, ApiError } from "@/lib/api-helpers";
import { requirePayment, settleQuietly, withPaymentReceipt } from "@/lib/payments/x402";
import { withJob } from "@/lib/jobs";
import { buildTraitLibrary, generateNonRepeatingToken } from "@/lib/trait-engine";
import { proposeTraitTaxonomy } from "@/lib/clients/anthropic";
import { getBrandKit, applyBrandConstraintsToPrompt } from "@/lib/brand-kit";
import { renderCollectionReportPdf } from "@/lib/pdf/report";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z
  .object({
    buyer_wallet: z.string().optional(),
    collection_id: z.string().uuid(),
    source_image_url: z.string().url().optional(),
    trait_categories: z
      .array(z.object({ category: z.string(), options: z.array(z.string()).min(1) }))
      .optional(),
    collection_size: z.number().int().min(1).max(10_000),
    brand_kit_id: z.string().uuid().optional()
  })
  .refine((v) => v.source_image_url || v.trait_categories, {
    message: "source_image_url or trait_categories is required"
  });

/**
 * S10: trait-based generative art engine. Builds (or reuses) a layered
 * trait library, then composites `collection_size` non-colliding tokens,
 * hash-deduping against issued_combos per collection. Fails gracefully
 * rather than looping forever if the trait library's combinatorial space
 * can't cover the requested size.
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    // Verify payment before spending anything downstream; settle only
    // after the job succeeds.
    const payment = await requirePayment(req, { serviceType: "s10_trait_engine", quantity: body.collection_size });
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet, payment.payer);
    const pricing = getToolDefinition("s10_trait_engine")!.pricing;

    const { job_id, output } = await withJob(
      {
        serviceType: "s10_trait_engine",
        buyerWallet,
        input: body,
        pricePaid: payment.amount,
        priceCurrency: payment.currency
      },
      async (jobId) => {
        const supabase = getSupabaseAdmin();
        const kit = body.brand_kit_id ? await getBrandKit(body.brand_kit_id) : null;

        const categories = body.trait_categories ?? (await proposeTraitTaxonomy(body.source_image_url!));
        const spaceSize = categories.reduce((product, c) => product * c.options.length, 1);
        if (spaceSize < body.collection_size) {
          throw new ApiError(
            422,
            `Trait taxonomy only supports ${spaceSize} unique combinations, which is fewer than the requested collection_size (${body.collection_size}). Expand trait_categories and retry.`
          );
        }

        const library = await buildTraitLibrary({
          collectionId: body.collection_id,
          categories,
          stylePrompt: applyBrandConstraintsToPrompt("consistent NFT collection art style", kit)
        });

        const issuedTokens: Array<{ tokenId: string; imageUrl: string; traits: Array<{ trait_type: string; value: string }> }> = [];
        let rejectedCollisions = 0;

        for (let i = 0; i < body.collection_size; i++) {
          const result = await generateNonRepeatingToken({ collectionId: body.collection_id, library });
          if (!result) {
            rejectedCollisions += 1;
            break; // combinatorial space exhausted -- stop rather than loop forever
          }
          const tokenId = String(i + 1);
          issuedTokens.push({
            tokenId,
            imageUrl: result.compositeUrl,
            traits: Object.entries(result.combo).map(([trait_type, value]) => ({ trait_type, value }))
          });
        }

        const manifest = {
          collection_id: body.collection_id,
          tokens_issued: issuedTokens.length,
          tokens: issuedTokens
        };

        const manifestPath = `trait-engine/${body.collection_id}/manifest.json`;
        const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets";
        await supabase.storage.from(bucket).upload(manifestPath, JSON.stringify(manifest, null, 2), {
          contentType: "application/json",
          upsert: true
        });
        const { data: manifestUrlData } = supabase.storage.from(bucket).getPublicUrl(manifestPath);

        const previewPdfUrl = await renderCollectionReportPdf({
          title: "Generative Collection Preview",
          collectionName: body.collection_id,
          tokenCount: issuedTokens.length,
          tokens: issuedTokens.map((t) => ({ tokenId: t.tokenId, imageUrl: t.imageUrl, traits: t.traits })),
          storagePathPrefix: `trait-engine/${body.collection_id}`
        });

        await supabase.from("media_assets").insert(
          issuedTokens.map((t) => ({
            job_id: jobId,
            type: "image" as const,
            url: t.imageUrl,
            source_prompt: null,
            metadata: { collection_id: body.collection_id, token_id: t.tokenId, traits: t.traits },
            brand_kit_id: body.brand_kit_id ?? null,
            qc_status: "pass" as const
          }))
        );

        return {
          manifest_url: manifestUrlData.publicUrl,
          preview_pdf_url: previewPdfUrl,
          tokens_issued: issuedTokens.length,
          rejected_collisions: rejectedCollisions
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
