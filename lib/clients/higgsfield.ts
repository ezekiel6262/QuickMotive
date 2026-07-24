/**
 * Thin server-side client for Higgsfield's generation API.
 *
 * KNOWN GAP: the interactive Higgsfield MCP tools available to a chat agent
 * (media_upload_widget, confirmed media_id/job_id chaining, presets, etc.)
 * are designed for a human-in-the-loop session, not a headless backend. This
 * client instead targets Higgsfield's server-to-server API surface using the
 * same operation names and param shapes as the MCP tool schemas
 * (generate_image, generate_video, motion_control, outpaint_image,
 * remove_background, upscale_image, upscale_video, reframe), because that is
 * the most concrete public contract available. Confirm the exact endpoint
 * paths/auth scheme against Higgsfield's developer docs before go-live --
 * see README "Known integration gaps".
 */

import { z } from "zod";

const HIGGSFIELD_BASE_URL = process.env.HIGGSFIELD_MCP_URL ?? "https://api.higgsfield.ai";

function requireApiKey(): string {
  const key = process.env.HIGGSFIELD_API_KEY;
  if (!key) throw new Error("HIGGSFIELD_API_KEY is not set");
  return key;
}

async function call<T>(op: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${HIGGSFIELD_BASE_URL}/v1/${op}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${requireApiKey()}`
    },
    body: JSON.stringify({ params })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Higgsfield ${op} failed: ${res.status} ${body}`);
  }

  return (await res.json()) as T;
}

export const mediaRefSchema = z.object({
  value: z.string(),
  role: z.string()
});
export type MediaRef = z.infer<typeof mediaRefSchema>;

export interface GenerationResult {
  job_id: string;
  status: "queued" | "processing" | "completed" | "failed";
  assets: Array<{ url: string; width?: number; height?: number; duration_seconds?: number }>;
  credits_charged?: number;
}

export async function generateImage(params: {
  model: string;
  prompt?: string;
  aspectRatio?: string;
  count?: number;
  medias?: MediaRef[];
  brandStyleRefUrl?: string;
}): Promise<GenerationResult> {
  return call<GenerationResult>("generate_image", {
    model: params.model,
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio,
    count: params.count ?? 1,
    medias: params.medias
  });
}

export async function generateVideo(params: {
  model: string;
  prompt?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  medias?: MediaRef[];
}): Promise<GenerationResult> {
  return call<GenerationResult>("generate_video", {
    model: params.model,
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio,
    duration: params.durationSeconds,
    medias: params.medias
  });
}

export async function motionControl(params: {
  imageId: string;
  motionDescription?: string;
  resolution?: "720p" | "1080p";
}): Promise<GenerationResult> {
  return call<GenerationResult>("motion_control", {
    image_id: params.imageId,
    motion_description: params.motionDescription,
    resolution: params.resolution ?? "720p"
  });
}

export async function outpaintImage(params: {
  imageId: string;
  aspectRatio: string;
  width?: number;
  height?: number;
}): Promise<GenerationResult> {
  return call<GenerationResult>("outpaint_image", {
    image_id: params.imageId,
    aspect_ratio: params.aspectRatio,
    width: params.width,
    height: params.height
  });
}

export async function removeBackground(params: {
  mediaId: string;
  mediaType: "image" | "video";
}): Promise<GenerationResult> {
  return call<GenerationResult>("remove_background", {
    media_id: params.mediaId,
    media_type: params.mediaType
  });
}

export async function upscaleImage(params: {
  imageId: string;
  width: number;
  height: number;
  resolution?: "2k" | "4k";
}): Promise<GenerationResult> {
  return call<GenerationResult>("upscale_image", {
    image_id: params.imageId,
    width: params.width,
    height: params.height,
    resolution: params.resolution ?? "4k"
  });
}

export async function upscaleVideo(params: {
  videoId: string;
  width: number;
  height: number;
  resolution?: "1080p" | "2k" | "4k";
}): Promise<GenerationResult> {
  return call<GenerationResult>("upscale_video", {
    provider: "bytedance",
    video_id: params.videoId,
    width: params.width,
    height: params.height,
    resolution: params.resolution ?? "2k"
  });
}

export async function reframe(params: {
  videoId: string;
  aspectRatio: string;
  resolution?: "480p" | "720p" | "1080p";
}): Promise<GenerationResult> {
  return call<GenerationResult>("reframe", {
    medias: [{ value: params.videoId, role: "video" }],
    aspect_ratio: params.aspectRatio,
    resolution: params.resolution
  });
}

export interface GameCreationInstructions {
  templates: Array<{ id: string; name: string; description: string }>;
  steps: string[];
}

export async function getGameCreationInstructions(): Promise<GameCreationInstructions> {
  return call<GameCreationInstructions>("get_game_creation_instructions", {});
}

export async function deployGame(params: {
  templateId: string;
  characterAssetUrl: string;
  title: string;
}): Promise<{ deploy_id: string; preview_url: string }> {
  return call("deploy_game", {
    template_id: params.templateId,
    character_asset_url: params.characterAssetUrl,
    title: params.title
  });
}

export async function publishGame(params: { deployId: string }): Promise<{ play_url: string }> {
  return call("publish_game", { deploy_id: params.deployId });
}
