import { getSupabaseAdmin } from "@/lib/supabase/client";
import type { BrandKitRow } from "@/lib/supabase/types";

export interface BrandKitInput {
  buyerWallet: string;
  brandKitId?: string;
  name: string;
  palette?: Array<{ hex: string; role: string }>;
  typography?: Record<string, unknown>;
  logoUrls?: string[];
  styleRefUrls?: string[];
  toneDescriptors?: string;
}

export async function upsertBrandKit(input: BrandKitInput): Promise<BrandKitRow> {
  const supabase = getSupabaseAdmin();
  const row = {
    buyer_wallet: input.buyerWallet,
    name: input.name,
    palette: input.palette ?? [],
    typography: input.typography ?? {},
    logo_urls: input.logoUrls ?? [],
    style_ref_urls: input.styleRefUrls ?? [],
    tone_descriptors: input.toneDescriptors ?? null
  };

  const query = input.brandKitId
    ? supabase.from("brand_kits").update(row).eq("id", input.brandKitId).select().single()
    : supabase.from("brand_kits").insert(row).select().single();

  const { data, error } = await query;
  if (error || !data) throw new Error(`Failed to save brand kit: ${error?.message ?? "unknown error"}`);
  return data;
}

export async function getBrandKit(brandKitId: string): Promise<BrandKitRow | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("brand_kits").select().eq("id", brandKitId).maybeSingle();
  if (error) throw new Error(`Failed to load brand kit ${brandKitId}: ${error.message}`);
  return data;
}

/**
 * Injects a brand kit's constraints into a generation prompt. Callers should
 * pass `style_ref_urls` separately as Higgsfield `medias` conditioning
 * inputs where the model supports it -- this only handles the text side.
 */
export function applyBrandConstraintsToPrompt(basePrompt: string, kit: BrandKitRow | null): string {
  if (!kit) return basePrompt;

  const constraints: string[] = [];
  if (kit.palette.length > 0) {
    constraints.push(`color palette limited to ${kit.palette.map((c) => `${c.hex} (${c.role})`).join(", ")}`);
  }
  if (kit.tone_descriptors) {
    constraints.push(`tone: ${kit.tone_descriptors}`);
  }

  if (constraints.length === 0) return basePrompt;
  return `${basePrompt}. Brand constraints: ${constraints.join("; ")}.`;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return [r, g, b];
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * Approximate palette-drift check: compares a generated asset's dominant
 * colors against the kit's approved palette. This is a heuristic, not a
 * guarantee -- flagged outputs are "worth a look," not a hard fail. See
 * README "Open risks" re: QC disputes.
 */
export function checkPaletteDrift(params: {
  dominantColors: string[]; // hex
  kit: BrandKitRow;
  toleranceDistance?: number;
}): { pass: boolean; reason?: string } {
  const tolerance = params.toleranceDistance ?? 60; // out of ~441 max RGB distance
  if (params.kit.palette.length === 0) return { pass: true };

  const approved = params.kit.palette.map((c) => hexToRgb(c.hex));
  const drifted = params.dominantColors.filter((hex) => {
    const rgb = hexToRgb(hex);
    return !approved.some((a) => colorDistance(a, rgb) <= tolerance);
  });

  if (drifted.length > params.dominantColors.length / 2) {
    return { pass: false, reason: `dominant colors [${drifted.join(", ")}] fall outside the approved palette` };
  }
  return { pass: true };
}
