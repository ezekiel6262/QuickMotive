import { createHash } from "node:crypto";
import sharp from "sharp";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import * as gemini from "@/lib/clients/gemini";
import * as stability from "@/lib/clients/stability";
import type { TraitLibraryRow } from "@/lib/supabase/types";

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets";

export interface TraitCategoryDefinition {
  category: string;
  options: string[];
}

/**
 * Step 2: generate a layered, transparent-background asset per trait
 * option via Gemini (image gen) + Stability AI (background removal), and
 * persist it to trait_library. Idempotent per (collection, category,
 * option) -- re-running with the same taxonomy does not duplicate rows
 * (unique constraint).
 */
export async function buildTraitLibrary(params: {
  collectionId: string;
  categories: TraitCategoryDefinition[];
  stylePrompt: string;
}): Promise<TraitLibraryRow[]> {
  const supabase = getSupabaseAdmin();
  const rows: TraitLibraryRow[] = [];

  for (const category of params.categories) {
    for (const option of category.options) {
      const generated = await gemini.generateImage({
        prompt: `${option} ${category.category}, isolated on plain background, for a layered NFT trait asset. Style: ${params.stylePrompt}`,
        aspectRatio: "1:1"
      });
      const firstAsset = generated.assets[0];
      if (!firstAsset) throw new Error(`No asset returned for trait ${category.category}:${option}`);

      const cutout = await stability.removeBackground({ imageUrl: firstAsset.url });
      const assetUrl = cutout.url;

      const { data, error } = await supabase
        .from("trait_library")
        .upsert(
          {
            collection_id: params.collectionId,
            category: category.category,
            option_name: option,
            asset_url: assetUrl,
            weight: 1.0
          },
          { onConflict: "collection_id,category,option_name" }
        )
        .select()
        .single();

      if (error || !data) throw new Error(`Failed to persist trait asset: ${error?.message}`);
      rows.push(data);
    }
  }

  return rows;
}

export interface TraitCombo {
  [category: string]: string; // category -> option_name
}

export function hashCombo(combo: TraitCombo): string {
  const sorted = Object.keys(combo)
    .sort()
    .map((k) => `${k}=${combo[k]}`)
    .join("|");
  return createHash("sha256").update(sorted).digest("hex");
}

function pickWeighted<T extends { option_name: string; weight: number }>(options: T[]): T {
  const totalWeight = options.reduce((sum, o) => sum + o.weight, 0);
  let r = Math.random() * totalWeight;
  for (const option of options) {
    r -= option.weight;
    if (r <= 0) return option;
  }
  return options[options.length - 1] as T;
}

/**
 * Step 3+4: composite a random trait combination and check it against
 * issued_combos before returning. Rejects and retries on collision; fails
 * gracefully (rather than looping forever) once the combinatorial space is
 * exhausted -- see README "Open risks" re: S10 dedup limits.
 */
export async function generateNonRepeatingToken(params: {
  collectionId: string;
  library: TraitLibraryRow[];
  maxAttempts?: number;
}): Promise<{ combo: TraitCombo; comboHash: string; compositeUrl: string } | null> {
  const supabase = getSupabaseAdmin();
  const byCategory = new Map<string, TraitLibraryRow[]>();
  for (const row of params.library) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }

  const spaceSize = Array.from(byCategory.values()).reduce((product, options) => product * options.length, 1);
  const maxAttempts = params.maxAttempts ?? Math.min(50, spaceSize);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const combo: TraitCombo = {};
    const chosenAssets: string[] = [];
    for (const [category, options] of byCategory) {
      const chosen = pickWeighted(options);
      combo[category] = chosen.option_name;
      chosenAssets.push(chosen.asset_url);
    }

    const comboHash = hashCombo(combo);
    const { data: existing } = await supabase
      .from("issued_combos")
      .select("id")
      .eq("collection_id", params.collectionId)
      .eq("trait_hash", comboHash)
      .maybeSingle();

    if (existing) continue; // collision, retry

    const compositeUrl = await compositeTraitAssets(chosenAssets, params.collectionId, comboHash);

    const { error: insertError } = await supabase
      .from("issued_combos")
      .insert({ collection_id: params.collectionId, trait_hash: comboHash });
    if (insertError) continue; // lost a race to another concurrent generation, retry

    return { combo, comboHash, compositeUrl };
  }

  // Trait library exhausted for this collection's requested size -- caller
  // must fail gracefully (or offer to auto-expand the trait library), not
  // loop forever.
  return null;
}

async function compositeTraitAssets(assetUrls: string[], collectionId: string, comboHash: string): Promise<string> {
  const layers = await Promise.all(
    assetUrls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch trait layer ${url}: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    })
  );

  const base = layers[0];
  if (!base) throw new Error("No trait layers to composite");
  const { width = 1024, height = 1024 } = await sharp(base).metadata();

  const composite = sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).composite(layers.map((layer) => ({ input: layer, gravity: "center" })));

  const buffer = await composite.png().toBuffer();

  const supabase = getSupabaseAdmin();
  const path = `trait-engine/${collectionId}/${comboHash}.png`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, {
    contentType: "image/png",
    upsert: true
  });
  if (error) throw new Error(`Failed to upload composite: ${error.message}`);

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
