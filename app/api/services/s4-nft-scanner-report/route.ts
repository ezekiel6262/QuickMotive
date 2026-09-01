import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError, ApiError } from "@/lib/api-helpers";
import { requirePayment, settleQuietly, withPaymentReceipt } from "@/lib/payments/x402";
import { withJob } from "@/lib/jobs";
import { listAllCollectionTokens, resolveCollectionMetadata, computeRarity } from "@/lib/clients/onchain";
import { renderCollectionReportPdf } from "@/lib/pdf/report";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  contract_address: z.string().min(1),
  chain: z.string().min(1),
  marketplace_url: z.string().url().optional(),
  max_tokens: z.number().int().positive().max(10_000).default(2000)
});

/**
 * S4: On-chain NFT collection scanner -> PDF report.
 * Resolve contract -> enumerate tokens -> normalize traits -> compute
 * rarity -> render cover+grid PDF, and return structured JSON alongside it.
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    // Verify payment before spending anything downstream; settle only
    // after the job succeeds.
    const payment = await requirePayment(req, { serviceType: "s4_nft_scanner_report", quantity: 1 });
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet, payment.payer);
    const pricing = getToolDefinition("s4_nft_scanner_report")!.pricing;

    const { job_id, output } = await withJob(
      {
        serviceType: "s4_nft_scanner_report",
        buyerWallet,
        input: body,
        pricePaid: payment.amount,
        priceCurrency: payment.currency
      },
      async (jobId) => {
        const supabase = getSupabaseAdmin();

        const collection = await resolveCollectionMetadata({
          contractAddress: body.contract_address,
          chain: body.chain
        });

        const tokens = await listAllCollectionTokens({
          contractAddress: body.contract_address,
          chain: body.chain,
          maxTokens: body.max_tokens
        });
        if (tokens.length === 0) {
          throw new ApiError(422, "No tokens found for this contract/chain -- verify the address and chain");
        }

        const rarity = computeRarity(tokens);

        const { data: scan, error: scanError } = await supabase
          .from("nft_scans")
          .insert({
            job_id: jobId,
            contract_address: body.contract_address,
            chain: body.chain,
            collection_name: collection.name,
            token_count: tokens.length
          })
          .select()
          .single();
        if (scanError || !scan) throw new Error(`Failed to persist scan: ${scanError?.message}`);

        const tokenRows = tokens.map((t) => ({
          scan_id: scan.id,
          token_id: t.tokenId,
          image_url: t.imageUrl,
          traits: t.traits,
          rarity_score: rarity.get(t.tokenId) ?? null
        }));
        const { error: tokensError } = await supabase.from("nft_tokens").insert(tokenRows);
        if (tokensError) throw new Error(`Failed to persist tokens: ${tokensError.message}`);

        const pdfUrl = await renderCollectionReportPdf({
          title: `${collection.name ?? body.contract_address} - Collection Report`,
          collectionName: collection.name ?? body.contract_address,
          tokenCount: tokens.length,
          floorPrice: collection.floorPrice,
          tokens: tokens.map((t) => ({
            tokenId: t.tokenId,
            imageUrl: t.imageUrl,
            traits: t.traits,
            rarityScore: rarity.get(t.tokenId)
          })),
          storagePathPrefix: `nft-scans/${scan.id}`
        });

        await supabase.from("nft_scans").update({ report_pdf_url: pdfUrl }).eq("id", scan.id);

        return {
          pdf_url: pdfUrl,
          json: {
            collection_name: collection.name,
            token_count: tokens.length,
            tokens: tokenRows
          }
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
