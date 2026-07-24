/**
 * Server-side client for Higgsfield's real REST API (platform.higgsfield.ai),
 * confirmed against Higgsfield's official JS SDK source
 * (github.com/higgsfield-ai/higgsfield-js) after the originally-guessed
 * shape in this file (Bearer auth, POST /v1/generate_image, synchronous
 * response) turned out not to match -- a live test against a deployed
 * HIGGSFIELD_MCP_URL returned 404 on that exact path.
 *
 * Confirmed real shape:
 * - Base URL: https://platform.higgsfield.ai (override via
 *   HIGGSFIELD_API_BASE_URL, NOT the old HIGGSFIELD_MCP_URL -- that env var
 *   name was itself a mistake; it pointed at Higgsfield's separate
 *   interactive MCP endpoint, not this REST API).
 * - Auth header: `Authorization: Key KEY_ID:KEY_SECRET` (NOT Bearer).
 *   HIGGSFIELD_API_KEY must hold the combined "KEY_ID:KEY_SECRET" string --
 *   verify the value copied from the cloud.higgsfield.ai dashboard is
 *   actually in that format, not a single opaque token.
 * - Endpoints are model-slug paths (e.g. "flux-pro/kontext/max/text-to-image"),
 *   not fixed operation names. POST /v1/{modelSlug} with { input: {...} }.
 * - Generation is async: the submit call returns a request id, poll
 *   GET /requests/{request_id}/status until status is "completed" /
 *   "failed" / "nsfw"; the completed payload carries `images` or `video`.
 *
 * UNVERIFIED: only the text-to-image model slug
 * ("flux-pro/kontext/max/text-to-image") has been confirmed against real
 * docs. The model slugs used below for video/motion/outpaint/background-
 * removal/upscale/reframe are placeholders and WILL likely 404 the same way
 * the old defaults did -- confirm each against Higgsfield's model catalog
 * (cloud.higgsfield.ai) before relying on them. getGameCreationInstructions/
 * deployGame/publishGame are entirely unverified against this REST API and
 * may only exist as MCP tools, not REST endpoints.
 *
 * Also unverified: whether polling can reliably complete within a single
 * Vercel serverless function's timeout for slower jobs (video generation
 * especially). The SDK supports an `hf_webhook` callback as the alternative
 * to polling -- worth switching to for anything video-shaped once basic
 * image generation is confirmed working end to end.
 */

const HIGGSFIELD_BASE_URL = process.env.HIGGSFIELD_API_BASE_URL ?? "https://platform.higgsfield.ai";
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30; // ~60s; long enough for image gen, likely not for video

function requireCredentials(): string {
  const credentials = process.env.HIGGSFIELD_API_KEY;
  if (!credentials) throw new Error("HIGGSFIELD_API_KEY is not set");
  return credentials;
}

function authHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Key ${requireCredentials()}`
  };
}

interface HiggsfieldJobResponse {
  request_id?: string;
  id?: string;
  status?: "queued" | "in_progress" | "completed" | "failed" | "nsfw";
  images?: Array<{ url: string; width?: number; height?: number }>;
  video?: { url: string; duration_seconds?: number };
  results?: { raw?: { url: string } };
  error?: string;
}

async function submitJob(modelSlug: string, input: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${HIGGSFIELD_BASE_URL}/v1/${modelSlug}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ input })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Higgsfield submit ${modelSlug} failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as HiggsfieldJobResponse;
  const requestId = json.request_id ?? json.id;
  if (!requestId) throw new Error(`Higgsfield submit ${modelSlug} did not return a request id`);
  return requestId;
}

async function pollJob(requestId: string): Promise<HiggsfieldJobResponse> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const res = await fetch(`${HIGGSFIELD_BASE_URL}/requests/${requestId}/status`, {
      headers: authHeaders()
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Higgsfield poll ${requestId} failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as HiggsfieldJobResponse;
    if (json.status === "completed") return json;
    if (json.status === "failed" || json.status === "nsfw") {
      throw new Error(`Higgsfield job ${requestId} ended with status "${json.status}": ${json.error ?? "no error detail"}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Higgsfield job ${requestId} did not complete within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s -- consider hf_webhook instead of polling for slower jobs`
  );
}

export interface GenerationResult {
  job_id: string;
  status: "queued" | "processing" | "completed" | "failed";
  assets: Array<{ url: string; width?: number; height?: number; duration_seconds?: number }>;
}

function toGenerationResult(requestId: string, job: HiggsfieldJobResponse): GenerationResult {
  const assets: GenerationResult["assets"] = [];
  if (job.images) {
    assets.push(...job.images.map((img) => ({ url: img.url, width: img.width, height: img.height })));
  }
  if (job.video) {
    assets.push({ url: job.video.url, duration_seconds: job.video.duration_seconds });
  }
  if (assets.length === 0 && job.results?.raw?.url) {
    assets.push({ url: job.results.raw.url });
  }
  return { job_id: requestId, status: "completed", assets };
}

async function runModel(modelSlug: string, input: Record<string, unknown>): Promise<GenerationResult> {
  const requestId = await submitJob(modelSlug, input);
  const job = await pollJob(requestId);
  return toGenerationResult(requestId, job);
}

export interface MediaRef {
  value: string;
  role: string;
}

export async function generateImage(params: {
  model?: string;
  prompt?: string;
  aspectRatio?: string;
  count?: number;
  medias?: MediaRef[];
  brandStyleRefUrl?: string;
}): Promise<GenerationResult> {
  const reference = params.medias?.find(
    (m) => m.role === "style_reference" || m.role === "image_reference"
  );
  // reference.value going through as-is: text-to-image and image-conditioned
  // generation are very likely different model slugs on Higgsfield's side
  // (per the SDK's model-per-endpoint design). Passing a reference image to
  // a text-to-image model probably no-ops or errors -- this needs a real
  // image-conditioned model slug once one is confirmed, at which point
  // params.model should default to that instead when medias is present.
  return runModel(params.model ?? "flux-pro/kontext/max/text-to-image", {
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio ?? "1:1",
    seed: Math.floor(Math.random() * 1_000_000),
    image_url: reference?.value
  });
}

/** UNVERIFIED model slug -- confirm against Higgsfield's catalog before relying on this. */
export async function generateVideo(params: {
  model?: string;
  prompt?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  medias?: MediaRef[];
}): Promise<GenerationResult> {
  const startImage = params.medias?.find((m) => m.role === "start_image" || m.role === "image_reference");
  return runModel(params.model ?? "kling/v2/text-to-video", {
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio,
    duration: params.durationSeconds,
    // UNVERIFIED field name for image-conditioned video -- confirm against
    // the model's actual input schema.
    image_url: startImage?.value
  });
}

/** UNVERIFIED model slug -- confirm against Higgsfield's catalog before relying on this. */
export async function motionControl(params: {
  model?: string;
  imageId: string;
  motionDescription?: string;
  resolution?: "720p" | "1080p";
}): Promise<GenerationResult> {
  return runModel(params.model ?? "motion-control/v1", {
    image_url: params.imageId,
    motion_description: params.motionDescription,
    resolution: params.resolution ?? "720p"
  });
}

/** UNVERIFIED model slug -- confirm against Higgsfield's catalog before relying on this. */
export async function outpaintImage(params: {
  model?: string;
  imageId: string;
  aspectRatio: string;
  width?: number;
  height?: number;
}): Promise<GenerationResult> {
  return runModel(params.model ?? "outpaint/v1", {
    image_url: params.imageId,
    aspect_ratio: params.aspectRatio,
    width: params.width,
    height: params.height
  });
}

/** UNVERIFIED model slug -- confirm against Higgsfield's catalog before relying on this. */
export async function removeBackground(params: {
  model?: string;
  mediaId: string;
  mediaType: "image" | "video";
}): Promise<GenerationResult> {
  return runModel(params.model ?? "remove-background/v1", {
    media_url: params.mediaId,
    media_type: params.mediaType
  });
}

/** UNVERIFIED model slug -- confirm against Higgsfield's catalog before relying on this. */
export async function upscaleImage(params: {
  model?: string;
  imageId: string;
  width: number;
  height: number;
  resolution?: "2k" | "4k";
}): Promise<GenerationResult> {
  return runModel(params.model ?? "upscale/image/v1", {
    image_url: params.imageId,
    width: params.width,
    height: params.height,
    resolution: params.resolution ?? "4k"
  });
}

/** UNVERIFIED model slug -- confirm against Higgsfield's catalog before relying on this. */
export async function upscaleVideo(params: {
  model?: string;
  videoId: string;
  width: number;
  height: number;
  resolution?: "1080p" | "2k" | "4k";
}): Promise<GenerationResult> {
  return runModel(params.model ?? "upscale/video/v1", {
    video_url: params.videoId,
    width: params.width,
    height: params.height,
    resolution: params.resolution ?? "2k"
  });
}

/** UNVERIFIED model slug -- confirm against Higgsfield's catalog before relying on this. */
export async function reframe(params: {
  model?: string;
  videoId: string;
  aspectRatio: string;
  resolution?: "480p" | "720p" | "1080p";
}): Promise<GenerationResult> {
  return runModel(params.model ?? "reframe/v1", {
    video_url: params.videoId,
    aspect_ratio: params.aspectRatio,
    resolution: params.resolution
  });
}

/**
 * UNVERIFIED against this REST API -- the build brief's game-creation tools
 * (get_game_creation_instructions / deploy_game / publish_game) may only
 * exist as Higgsfield MCP tools with no REST equivalent. Needs its own
 * investigation before S11 will work; left as a stub shape for now.
 */
export interface GameCreationInstructions {
  templates: Array<{ id: string; name: string; description: string }>;
  steps: string[];
}

async function restCall<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${HIGGSFIELD_BASE_URL}${path}`, { ...init, headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Higgsfield ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

export async function getGameCreationInstructions(): Promise<GameCreationInstructions> {
  return restCall<GameCreationInstructions>("/v1/games/instructions", { method: "GET" });
}

export async function deployGame(params: {
  templateId: string;
  characterAssetUrl: string;
  title: string;
}): Promise<{ deploy_id: string; preview_url: string }> {
  return restCall("/v1/games/deploy", {
    method: "POST",
    body: JSON.stringify({
      template_id: params.templateId,
      character_asset_url: params.characterAssetUrl,
      title: params.title
    })
  });
}

export async function publishGame(params: { deployId: string }): Promise<{ play_url: string }> {
  return restCall(`/v1/games/${params.deployId}/publish`, { method: "POST" });
}
