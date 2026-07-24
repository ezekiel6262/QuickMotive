/**
 * fal.ai queue API client. Used specifically to get a real img2img
 * "strength" parameter for S7 (NFT variation) -- Gemini has no equivalent
 * mechanism (see lib/clients/gemini.ts). fal.ai hosts Qwen-Image directly
 * as a pay-per-use endpoint (no Higgsfield-style subscription markup).
 *
 * Confirmed against docs.fal.ai and the qwen-image/image-to-image model
 * page's published input schema before wiring:
 * - Auth: header `Authorization: Key <FAL_KEY>`.
 * - Submit: POST https://queue.fal.run/{model_id} with the model's JSON
 *   input -> { request_id, status_url, response_url }.
 * - Poll: GET https://queue.fal.run/{model_id}/requests/{request_id}/status
 *   until status is "COMPLETED" (or a terminal failure status).
 * - Result: GET https://queue.fal.run/{model_id}/requests/{request_id} ->
 *   { images: [{ url, width, height }], ... }.
 *
 * qwen-image/image-to-image's relevant input fields: prompt, image_url,
 * strength (0-1, default 0.6; 1.0 = fully remake, 0.0 = preserve original
 * -- exactly the img2img semantics this service needs), num_inference_steps
 * (default 30), guidance_scale.
 */

const FAL_QUEUE_BASE_URL = "https://queue.fal.run";
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30; // ~60s

function requireApiKey(): string {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new Error("FAL_API_KEY is not set");
  return key;
}

function authHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Key ${requireApiKey()}`
  };
}

interface FalSubmitResponse {
  request_id: string;
}

interface FalStatusResponse {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | string;
}

interface FalImageResult {
  images?: Array<{ url: string; width?: number; height?: number }>;
}

async function submit(modelId: string, input: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${FAL_QUEUE_BASE_URL}/${modelId}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(input)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fal.ai submit ${modelId} failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as FalSubmitResponse;
  if (!json.request_id) throw new Error(`fal.ai submit ${modelId} did not return a request_id`);
  return json.request_id;
}

async function pollUntilComplete(modelId: string, requestId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const res = await fetch(`${FAL_QUEUE_BASE_URL}/${modelId}/requests/${requestId}/status`, {
      headers: authHeaders()
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`fal.ai status ${requestId} failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as FalStatusResponse;
    if (json.status === "COMPLETED") return;
    if (json.status !== "IN_QUEUE" && json.status !== "IN_PROGRESS") {
      throw new Error(`fal.ai request ${requestId} ended with unexpected status "${json.status}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`fal.ai request ${requestId} did not complete within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`);
}

async function getResult(modelId: string, requestId: string): Promise<FalImageResult> {
  const res = await fetch(`${FAL_QUEUE_BASE_URL}/${modelId}/requests/${requestId}`, {
    headers: authHeaders()
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fal.ai result ${requestId} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as FalImageResult;
}

/**
 * Real img2img with a strength dial, via Qwen-Image on fal.ai.
 * strength: 0 (preserve original) - 1 (fully remake); default 0.6.
 */
export async function qwenImageToImage(params: {
  imageUrl: string;
  prompt: string;
  strength?: number;
}): Promise<{ url: string }> {
  const modelId = "fal-ai/qwen-image/image-to-image";
  const requestId = await submit(modelId, {
    image_url: params.imageUrl,
    prompt: params.prompt,
    strength: params.strength ?? 0.6
  });
  await pollUntilComplete(modelId, requestId);
  const result = await getResult(modelId, requestId);
  const url = result.images?.[0]?.url;
  if (!url) throw new Error(`fal.ai request ${requestId} completed with no image output`);
  return { url };
}
