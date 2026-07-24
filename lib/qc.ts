import sharp from "sharp";
import { checkPaletteDrift } from "@/lib/brand-kit";
import type { BrandKitRow } from "@/lib/supabase/types";

export interface QcResult {
  pass: boolean;
  reasons: string[];
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Coarse dominant-color approximation: downsample to a 4x4 grid and read each cell. */
async function extractDominantColors(buffer: Buffer): Promise<string[]> {
  const { data, info } = await sharp(buffer)
    .resize(4, 4, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const colors: string[] = [];
  const channels = info.channels;
  for (let i = 0; i < data.length; i += channels) {
    colors.push(toHex(data[i]!, data[i + 1]!, data[i + 2]!));
  }
  return colors;
}

/**
 * QC gate used by S8 (and reusable by S5's post-generation check): validates
 * a generated image against aspect ratio and, if a brand kit is set,
 * approximate palette drift. This is a heuristic, not a guarantee -- see
 * README "Open risks" re: borderline disputes.
 */
export async function runQcCheck(params: {
  imageUrl: string;
  targetAspectRatio?: string; // "1:1", "16:9", etc.
  brandKit?: BrandKitRow | null;
}): Promise<QcResult> {
  const reasons: string[] = [];

  const res = await fetch(params.imageUrl);
  if (!res.ok) return { pass: false, reasons: [`asset unreachable: ${res.status}`] };
  const buffer = Buffer.from(await res.arrayBuffer());

  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) {
    return { pass: false, reasons: ["could not decode image -- likely a generation artifact"] };
  }

  if (params.targetAspectRatio) {
    const [w, h] = params.targetAspectRatio.split(":").map(Number);
    if (w && h) {
      const expected = w / h;
      const actual = metadata.width / metadata.height;
      if (Math.abs(expected - actual) / expected > 0.05) {
        reasons.push(`aspect ratio ${metadata.width}x${metadata.height} does not match target ${params.targetAspectRatio}`);
      }
    }
  }

  if (params.brandKit) {
    const dominantColors = await extractDominantColors(buffer);
    const drift = checkPaletteDrift({ dominantColors, kit: params.brandKit });
    if (!drift.pass) reasons.push(drift.reason ?? "palette drift detected");
  }

  return { pass: reasons.length === 0, reasons };
}
