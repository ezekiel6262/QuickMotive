import sharp from "sharp";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import {
  DEFAULT_MARKETPLACE,
  MARKETPLACE_SPECS,
  SOCIAL_CROP_SPECS,
  PRINT_SPEC,
  WEB_SPEC,
  type ExportSpec
} from "@/config/marketplace-specs";

export interface NftMetadata {
  name: string;
  description: string;
  image: string;
  attributes: Array<{ trait_type: string; value: string }>;
}

export interface ExportBundleResult {
  target: string;
  fileUrl: string;
  metadata?: NftMetadata;
}

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets";

async function fetchSourceImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch source asset ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function renderAndUpload(
  source: Buffer,
  spec: ExportSpec,
  pathPrefix: string
): Promise<string> {
  const supabase = getSupabaseAdmin();
  let pipeline = sharp(source).resize(spec.width, spec.height, { fit: "cover" });
  pipeline = spec.format === "png" ? pipeline.png() : spec.format === "jpg" ? pipeline.jpeg({ quality: 88 }) : pipeline.webp({ quality: 82 });

  const buffer = await pipeline.toBuffer();
  const path = `${pathPrefix}/${spec.target.replace(/[:]/g, "-")}.${spec.format}`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, {
    contentType: `image/${spec.format}`,
    upsert: true
  });
  if (error) throw new Error(`Upload failed for ${path}: ${error.message}`);

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Shared post-processing step for every NFT-facing service. Packages one
 * source asset into every format a buyer needs from a single generation
 * instead of forcing a regeneration per target.
 */
export async function buildExportBundle(params: {
  sourceAssetUrl: string;
  mediaAssetId: string;
  targets: Array<"marketplace" | "social" | "print" | "web">;
  marketplace?: string;
  nftMetadataBase?: { name: string; description: string; attributes: Array<{ trait_type: string; value: string }> };
}): Promise<{ manifest: ExportBundleResult[] }> {
  const source = await fetchSourceImage(params.sourceAssetUrl);
  const pathPrefix = `exports/${params.mediaAssetId}`;
  const manifest: ExportBundleResult[] = [];
  const supabase = getSupabaseAdmin();

  const specs: ExportSpec[] = [];
  if (params.targets.includes("marketplace")) {
    const key = params.marketplace ?? DEFAULT_MARKETPLACE;
    const spec = MARKETPLACE_SPECS[key];
    if (!spec) throw new Error(`Unknown marketplace "${key}". Known: ${Object.keys(MARKETPLACE_SPECS).join(", ")}`);
    specs.push(spec);
  }
  if (params.targets.includes("social")) {
    specs.push(...Object.values(SOCIAL_CROP_SPECS));
  }
  if (params.targets.includes("print")) specs.push(PRINT_SPEC);
  if (params.targets.includes("web")) specs.push(WEB_SPEC);

  for (const spec of specs) {
    const fileUrl = await renderAndUpload(source, spec, pathPrefix);

    let metadata: NftMetadata | undefined;
    if (spec.target.startsWith("marketplace:") && params.nftMetadataBase) {
      metadata = { ...params.nftMetadataBase, image: fileUrl };
      const metadataPath = `${pathPrefix}/${spec.target.replace(/[:]/g, "-")}.metadata.json`;
      await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(metadataPath, JSON.stringify(metadata, null, 2), {
          contentType: "application/json",
          upsert: true
        });
    }

    manifest.push({ target: spec.target, fileUrl, metadata });

    await supabase.from("export_bundles").insert({
      media_asset_id: params.mediaAssetId,
      target: spec.target,
      file_url: fileUrl,
      metadata_json: metadata ?? {}
    });
  }

  return { manifest };
}
