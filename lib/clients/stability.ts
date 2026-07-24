/**
 * Stability AI Developer Platform (api.stability.ai) client, used
 * specifically for S7's genuine img2img "strength" dial -- see
 * lib/clients/gemini.ts's header comment for why Gemini (used for every
 * other image generation call in this suite) can't do this: strength is a
 * diffusion-sampling parameter, not something bolt-onable from outside a
 * real diffusion model.
 *
 * Request shape confirmed via a third-party proxy that mirrors Stability's
 * v2beta parameters verbatim (Stability's own docs pages returned 403 to
 * automated fetches, same as several other vendors' docs today) --
 * reasonably confident but verify against a real call before fully
 * trusting this in production.
 *
 * Endpoint: POST https://api.stability.ai/v2beta/stable-image/generate/sd3
 * Auth: header `Authorization: Bearer <STABILITY_API_KEY>`.
 * Request: multipart/form-data -- prompt, image (file), strength (0-1,
 * 0 = keep original, 1 = ignore it), mode="image-to-image",
 * model="sd3.5-medium" (~$0.035/image), output_format="png".
 * Response: with header `Accept: image/*`, the raw image bytes come back
 * directly in the response body (not JSON) -- read as an ArrayBuffer.
 */

import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/client";

const STABILITY_BASE_URL = "https://api.stability.ai";
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets";

function requireApiKey(): string {
  const key = process.env.STABILITY_API_KEY;
  if (!key) throw new Error("STABILITY_API_KEY is not set");
  return key;
}

/**
 * Real img2img with a strength dial. strength: 0 (keep original) - 1
 * (ignore it and regenerate freely).
 */
export async function imageToImage(params: {
  imageUrl: string;
  prompt: string;
  strength?: number;
}): Promise<{ url: string }> {
  const sourceRes = await fetch(params.imageUrl);
  if (!sourceRes.ok) {
    throw new Error(`Failed to fetch source image ${params.imageUrl}: ${sourceRes.status}`);
  }
  const sourceBlob = new Blob([await sourceRes.arrayBuffer()]);

  const form = new FormData();
  form.set("prompt", params.prompt);
  form.set("image", sourceBlob, "source.png");
  form.set("strength", String(params.strength ?? 0.5));
  form.set("mode", "image-to-image");
  form.set("model", "sd3.5-medium");
  form.set("output_format", "png");

  const res = await fetch(`${STABILITY_BASE_URL}/v2beta/stable-image/generate/sd3`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requireApiKey()}`,
      accept: "image/*"
    },
    body: form
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Stability image-to-image failed: ${res.status} ${body}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const path = `generated/${randomUUID()}.png`;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, {
    contentType: "image/png",
    upsert: true
  });
  if (error) throw new Error(`Failed to upload generated image: ${error.message}`);

  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return { url: urlData.publicUrl };
}
