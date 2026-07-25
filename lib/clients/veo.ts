/**
 * Google Veo (via the Gemini API) video generation client -- replaces
 * Higgsfield for S2 (video motion from a single image). Confirmed against
 * multiple independent sources (Google AI Developer forum threads, Google
 * Cloud docs, third-party API guides) before wiring, same standard as
 * Gemini's image client.
 *
 * Endpoint: POST
 * https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning
 * Auth: header `x-goog-api-key: <GEMINI_API_KEY>` (same key as
 * lib/clients/gemini.ts).
 * Request: { instances: [{ prompt, image: { bytesBase64Encoded, mimeType } }],
 * parameters: { aspectRatio, durationSeconds, ... } }.
 * This kicks off a long-running operation, not a synchronous response:
 * poll GET /v1beta/{operation_name} until `done: true`, then the video
 * comes back as base64 at
 * response.generateVideoResponse.generatedSamples[0].video.bytesBase64Encoded.
 *
 * PRICING WARNING: standard Veo 3.1 is $0.40/sec ($3.20 for an 8s clip).
 * This client defaults to the "fast" tier (veo-3.1-fast-generate-preview,
 * ~$0.10-0.15/sec, ~$0.75-1.20 for an 8s clip) to stay closer to the rest
 * of this suite's cost profile -- confirm current pricing at ai.google.dev
 * before relying on this for volume, and reconsider S2's A2MCP price
 * (currently a flat $0.40/call placeholder in lib/a2mcp/registry.ts)
 * against the real per-second cost.
 *
 * TIMEOUT RISK: video generation commonly takes 30s-2min+. Polling
 * synchronously inside a single request (as this client does, for
 * consistency with this suite's other providers) will likely exceed
 * Vercel's default serverless function timeout. This needs a webhook or
 * async-job redesign (return job_id immediately, poll status via a
 * separate endpoint) before relying on it in production -- flagging
 * rather than guessing at a fix, since it changes the route's response
 * shape.
 */

import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/client";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "veo-3.1-fast-generate-preview";
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets";
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 24; // ~2 minutes

function requireApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

// Veo 3.1 rejects any durationSeconds outside {4, 6, 8} -- confirmed live
// via a 400 INVALID_ARGUMENT on a value of 5. Snap to the nearest valid
// value rather than trusting the caller.
const VALID_DURATIONS = [4, 6, 8] as const;
function nearestValidDuration(requested: number): number {
  return VALID_DURATIONS.reduce((closest, v) =>
    Math.abs(v - requested) < Math.abs(closest - requested) ? v : closest
  );
}

async function fetchAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch source image ${url}: ${res.status}`);
  const mimeType = res.headers.get("content-type") ?? "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { data: buffer.toString("base64"), mimeType };
}

interface OperationResponse {
  name?: string;
  done?: boolean;
  error?: { message: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { bytesBase64Encoded?: string; mimeType?: string } }>;
    };
  };
}

/**
 * imageUrl is optional -- Veo supports both text-to-video (omit it) and
 * image-to-video (provide it). When provided with no prompt, defaults to
 * a generic "animate this" instruction.
 */
export async function generateVideo(params: {
  imageUrl?: string;
  prompt?: string;
  durationSeconds?: number;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
}): Promise<{ url: string; durationSeconds: number }> {
  if (!params.imageUrl && !params.prompt) {
    throw new Error("generateVideo requires at least one of imageUrl or prompt");
  }
  const image = params.imageUrl ? await fetchAsBase64(params.imageUrl) : null;
  const durationSeconds = nearestValidDuration(params.durationSeconds ?? 6);

  const instance: Record<string, unknown> = {
    prompt: params.prompt ?? "Animate this image with subtle, natural motion."
  };
  if (image) instance.image = { bytesBase64Encoded: image.data, mimeType: image.mimeType };

  const submitRes = await fetch(`${GEMINI_BASE_URL}/models/${MODEL}:predictLongRunning`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": requireApiKey() },
    body: JSON.stringify({
      instances: [instance],
      parameters: {
        aspectRatio: params.aspectRatio ?? "16:9",
        resolution: params.resolution ?? "720p",
        durationSeconds
      }
    })
  });

  if (!submitRes.ok) {
    const body = await submitRes.text().catch(() => "");
    throw new Error(`Veo submit failed: ${submitRes.status} ${body}`);
  }

  const submitJson = (await submitRes.json()) as OperationResponse;
  const operationName = submitJson.name;
  if (!operationName) throw new Error("Veo submit did not return an operation name");

  let final: OperationResponse | null = null;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const pollRes = await fetch(`${GEMINI_BASE_URL}/${operationName}`, {
      headers: { "x-goog-api-key": requireApiKey() }
    });
    if (!pollRes.ok) {
      const body = await pollRes.text().catch(() => "");
      throw new Error(`Veo poll failed: ${pollRes.status} ${body}`);
    }
    const pollJson = (await pollRes.json()) as OperationResponse;
    if (pollJson.done) {
      final = pollJson;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (!final) {
    throw new Error(
      `Veo operation ${operationName} did not complete within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`
    );
  }
  if (final.error) throw new Error(`Veo operation failed: ${final.error.message}`);

  const sample = final.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
  if (!sample?.bytesBase64Encoded) throw new Error("Veo operation completed with no video output");

  const buffer = Buffer.from(sample.bytesBase64Encoded, "base64");
  const ext = (sample.mimeType ?? "video/mp4").split("/")[1] ?? "mp4";
  const path = `generated/${randomUUID()}.${ext}`;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, buffer, {
    contentType: sample.mimeType ?? "video/mp4",
    upsert: true
  });
  if (error) throw new Error(`Failed to upload generated video: ${error.message}`);

  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return { url: urlData.publicUrl, durationSeconds };
}
