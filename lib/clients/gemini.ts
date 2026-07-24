/**
 * Google Gemini API client for gemini-2.5-flash-image (community name
 * "Nano Banana") -- direct image generation, replacing Higgsfield's markup
 * for this operation per cost concerns. Confirmed against multiple
 * independent Google sources (ai.google.dev search results, the official
 * google-gemini/cookbook repo, and a GoogleCloudPlatform/generative-ai
 * notebook) before wiring, after the earlier lesson from guessing
 * Higgsfield's shape and getting it wrong on the first live test.
 *
 * Endpoint: POST
 * https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent
 * Auth: header `x-goog-api-key: <GEMINI_API_KEY>` -- get a free-tier key at
 * aistudio.google.com (no credit card required for the free tier, per
 * Google's own docs, though check current limits before relying on that
 * for production volume).
 * Request: { contents: [{ parts: [...] }], generationConfig: {
 *   responseModalities: ["IMAGE"], imageConfig: { aspectRatio } } }.
 * Reference images (for S6/S7 style/image conditioning) go in as
 * additional `inlineData` parts before the text part -- Gemini is natively
 * multimodal, so this is the documented way to condition generation on an
 * input image rather than a separate "model slug."
 * Response: candidates[0].content.parts[] -- the generated image is
 * whichever part has `inlineData: { mimeType, data (base64) }`.
 *
 * Gemini returns image bytes inline rather than a hosted URL, so this
 * uploads the result to Supabase Storage and returns a public URL to match
 * the shape the rest of the app expects from a generation call.
 */

import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/client";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-2.5-flash-image";
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets";

function requireApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

async function fetchAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch reference image ${url}: ${res.status}`);
  const mimeType = res.headers.get("content-type") ?? "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { data: buffer.toString("base64"), mimeType };
}

export interface GenerationResult {
  job_id: string;
  status: "completed";
  assets: Array<{ url: string }>;
}

export async function generateImage(params: {
  prompt?: string;
  aspectRatio?: string;
  medias?: Array<{ value: string; role: string }>;
}): Promise<GenerationResult> {
  const parts: GeminiPart[] = [];

  for (const media of params.medias ?? []) {
    const { data, mimeType } = await fetchAsBase64(media.value);
    parts.push({ inlineData: { mimeType, data } });
  }
  parts.push({ text: params.prompt ?? "" });

  const res = await fetch(`${GEMINI_BASE_URL}/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": requireApiKey()
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: params.aspectRatio ?? "1:1" }
      }
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini generateContent failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as GeminiResponse;
  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request: ${json.promptFeedback.blockReason}`);
  }

  const imagePart = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!imagePart?.inlineData) {
    throw new Error(
      `Gemini returned no image data (finishReason: ${json.candidates?.[0]?.finishReason ?? "unknown"})`
    );
  }

  const buffer = Buffer.from(imagePart.inlineData.data, "base64");
  const ext = imagePart.inlineData.mimeType.split("/")[1] ?? "png";
  const path = `generated/${randomUUID()}.${ext}`;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, {
    contentType: imagePart.inlineData.mimeType,
    upsert: true
  });
  if (error) throw new Error(`Failed to upload generated image: ${error.message}`);

  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);

  return {
    job_id: randomUUID(),
    status: "completed",
    assets: [{ url: urlData.publicUrl }]
  };
}
