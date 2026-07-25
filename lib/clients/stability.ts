/**
 * Stability AI Developer Platform (api.stability.ai) client. Covers three
 * operations that replace Higgsfield in this suite:
 * - imageToImage: S7's genuine img2img "strength" dial -- see
 *   lib/clients/gemini.ts's header comment for why Gemini can't do this.
 * - outpaint: S3's non-destructive raster region edit.
 * - removeBackground: S10's trait-library cutout step.
 *
 * Request shapes confirmed via a third-party proxy mirroring Stability's
 * own parameters plus search-indexed doc snippets (Stability's own docs
 * pages 403'd automated fetches, same as several other vendors' did) --
 * reasonably confident but verify against a real call before fully
 * trusting any of these in production.
 *
 * Auth: header `Authorization: Bearer <STABILITY_API_KEY>` on every
 * endpoint below. Requests are multipart/form-data; responses come back
 * as raw image bytes directly (header `Accept: image/*`) rather than
 * JSON+base64.
 */

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { getSupabaseAdmin } from "@/lib/supabase/client";

const STABILITY_BASE_URL = "https://api.stability.ai";
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets";

function requireApiKey(): string {
  const key = process.env.STABILITY_API_KEY;
  if (!key) throw new Error("STABILITY_API_KEY is not set");
  return key;
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch source image ${url}: ${res.status}`);
  return new Blob([await res.arrayBuffer()]);
}

async function callStability(path: string, form: FormData): Promise<Buffer> {
  const res = await fetch(`${STABILITY_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requireApiKey()}`,
      accept: "image/*"
    },
    body: form
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Stability ${path} failed: ${res.status} ${body}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function uploadImageBuffer(buffer: Buffer): Promise<{ url: string }> {
  const uploadPath = `generated/${randomUUID()}.png`;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(uploadPath, buffer, {
    contentType: "image/png",
    upsert: true
  });
  if (error) throw new Error(`Failed to upload generated image: ${error.message}`);

  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(uploadPath);
  return { url: urlData.publicUrl };
}

async function postForImage(path: string, form: FormData): Promise<{ url: string }> {
  const buffer = await callStability(path, form);
  return uploadImageBuffer(buffer);
}

/**
 * Real img2img with a strength dial. strength: 0 (keep original) - 1
 * (ignore it and regenerate freely). Model: sd3.5-medium (~$0.035/image).
 */
export async function imageToImage(params: {
  imageUrl: string;
  prompt: string;
  strength?: number;
}): Promise<{ url: string }> {
  const form = new FormData();
  form.set("prompt", params.prompt);
  form.set("image", await fetchAsBlob(params.imageUrl), "source.png");
  form.set("strength", String(params.strength ?? 0.5));
  form.set("mode", "image-to-image");
  form.set("model", "sd3.5-medium");
  form.set("output_format", "png");

  return postForImage("/v2beta/stable-image/generate/sd3", form);
}

/**
 * Non-destructive region edit: extends an image outward in the given
 * directions (pixels), optionally guided by a prompt for the new content.
 * Used by S3 for raster assets that aren't Canva-native designs.
 */
export async function outpaint(params: {
  imageUrl: string;
  left?: number;
  right?: number;
  up?: number;
  down?: number;
  prompt?: string;
}): Promise<{ url: string }> {
  if (!params.left && !params.right && !params.up && !params.down) {
    throw new Error("outpaint requires at least one of left/right/up/down to be non-zero");
  }

  const form = new FormData();
  form.set("image", await fetchAsBlob(params.imageUrl), "source.png");
  if (params.left) form.set("left", String(params.left));
  if (params.right) form.set("right", String(params.right));
  if (params.up) form.set("up", String(params.up));
  if (params.down) form.set("down", String(params.down));
  if (params.prompt) form.set("prompt", params.prompt);
  form.set("output_format", "png");

  return postForImage("/v2beta/stable-image/edit/outpaint", form);
}

/**
 * Cuts out the foreground subject, returning a transparent-background
 * PNG. Used by S10's trait library build step.
 */
export async function removeBackground(params: { imageUrl: string }): Promise<{ url: string }> {
  const form = new FormData();
  form.set("image", await fetchAsBlob(params.imageUrl), "source.png");
  form.set("output_format", "png");

  return postForImage("/v2beta/stable-image/edit/remove-background", form);
}

/**
 * Regenerates the masked region of an image per a prompt, leaving
 * everything else pixel-identical. mask convention (per Stability's
 * inpaint docs): white = edit this area, black = keep as-is.
 */
export async function inpaint(params: {
  imageUrl: string;
  maskBuffer: Buffer;
  prompt: string;
}): Promise<{ url: string }> {
  const form = new FormData();
  form.set("image", await fetchAsBlob(params.imageUrl), "source.png");
  // Buffer's ArrayBufferLike type (which can include SharedArrayBuffer)
  // isn't assignable to BlobPart's stricter ArrayBuffer requirement in
  // newer TS DOM lib versions -- Node's Blob accepts Buffer directly at
  // runtime regardless.
  form.set("mask", new Blob([params.maskBuffer as unknown as BlobPart]), "mask.png");
  form.set("prompt", params.prompt);
  form.set("output_format", "png");

  return postForImage("/v2beta/stable-image/edit/inpaint", form);
}

/**
 * S3's raster region-edit: buyer gives an instruction like "make the
 * background blue" with no explicit mask. Derives one automatically by
 * cutting out the foreground (removeBackground) and inverting its alpha
 * channel, so only the background changes and the foreground subject
 * stays pixel-identical -- matching the brief's "non-destructive region
 * editing" intent without requiring the buyer to supply a mask.
 */
export async function editBackgroundRegion(params: {
  imageUrl: string;
  instruction: string;
}): Promise<{ url: string }> {
  const cutoutForm = new FormData();
  cutoutForm.set("image", await fetchAsBlob(params.imageUrl), "source.png");
  cutoutForm.set("output_format", "png");
  const cutoutBuffer = await callStability("/v2beta/stable-image/edit/remove-background", cutoutForm);

  // Invert the cutout's alpha channel: opaque foreground -> black (keep),
  // transparent background -> white (edit).
  const { data: alpha, info } = await sharp(cutoutBuffer)
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const invertedAlpha = Buffer.from(alpha.map((v) => 255 - v));
  const maskBuffer = await sharp(invertedAlpha, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png()
    .toBuffer();

  return inpaint({ imageUrl: params.imageUrl, maskBuffer, prompt: params.instruction });
}
