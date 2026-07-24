import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { getSupabaseAdmin } from "@/lib/supabase/client";

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets";

export interface ReportToken {
  tokenId: string;
  imageUrl: string | null;
  traits: Array<{ trait_type: string; value: string }>;
  rarityScore?: number;
}

export interface CollectionReportInput {
  title: string;
  collectionName: string;
  tokenCount: number;
  floorPrice?: number | null;
  volume24h?: number | null;
  tokens: ReportToken[];
  storagePathPrefix: string;
}

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 36;

async function tryEmbedImage(doc: PDFDocument, url: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("png") || url.endsWith(".png")) return await doc.embedPng(bytes);
    return await doc.embedJpg(bytes);
  } catch {
    return null;
  }
}

function drawText(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size = 10) {
  page.drawText(text, { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
}

/**
 * Cover page + paginated thumbnail grid with trait tables. Shared by S4
 * (on-chain scanner) and S10 (trait engine preview sheet) so both reuse the
 * same renderer rather than duplicating layout logic.
 */
export async function renderCollectionReportPdf(input: CollectionReportInput): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Cover page
  const cover = doc.addPage([PAGE_W, PAGE_H]);
  cover.drawText(input.title, { x: MARGIN, y: PAGE_H - 80, size: 24, font: bold });
  drawText(cover, `Collection: ${input.collectionName}`, MARGIN, PAGE_H - 120, font, 14);
  drawText(cover, `Token count: ${input.tokenCount}`, MARGIN, PAGE_H - 145, font, 12);
  if (input.floorPrice != null) drawText(cover, `Floor price: ${input.floorPrice}`, MARGIN, PAGE_H - 165, font, 12);
  if (input.volume24h != null) drawText(cover, `24h volume: ${input.volume24h}`, MARGIN, PAGE_H - 185, font, 12);
  drawText(cover, `Generated ${new Date().toISOString()}`, MARGIN, MARGIN, font, 8);

  // Thumbnail grid, 2 columns x 3 rows per page, with a trait table under each.
  const cols = 2;
  const cellW = (PAGE_W - MARGIN * 2) / cols;
  const cellH = 230;
  const rowsPerPage = Math.floor((PAGE_H - MARGIN * 2) / cellH);

  let page: PDFPage | null = null;
  let cellIndex = 0;

  for (const token of input.tokens) {
    const rowOnPage = Math.floor(cellIndex / cols) % rowsPerPage;
    const col = cellIndex % cols;

    if (rowOnPage === 0 && col === 0) {
      page = doc.addPage([PAGE_W, PAGE_H]);
    }
    if (!page) page = doc.addPage([PAGE_W, PAGE_H]);

    const x = MARGIN + col * cellW;
    const y = PAGE_H - MARGIN - (rowOnPage + 1) * cellH;

    if (token.imageUrl) {
      const img = await tryEmbedImage(doc, token.imageUrl);
      if (img) {
        const thumbSize = 120;
        const scaled = img.scale(Math.min(thumbSize / img.width, thumbSize / img.height));
        page.drawImage(img, { x, y: y + cellH - scaled.height - 16, width: scaled.width, height: scaled.height });
      }
    }

    drawText(page, `#${token.tokenId}`, x, y + cellH - 8, bold, 11);
    if (token.rarityScore != null) {
      drawText(page, `Rarity: ${token.rarityScore.toFixed(2)}`, x + 130, y + cellH - 8, font, 9);
    }

    let traitY = y + cellH - 110;
    for (const trait of token.traits.slice(0, 6)) {
      drawText(page, `${trait.trait_type}: ${trait.value}`, x, traitY, font, 8);
      traitY -= 11;
    }

    cellIndex += 1;
  }

  const bytes = await doc.save();
  const supabase = getSupabaseAdmin();
  const path = `${input.storagePathPrefix}/report.pdf`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, bytes, {
    contentType: "application/pdf",
    upsert: true
  });
  if (error) throw new Error(`Failed to upload report PDF: ${error.message}`);

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
