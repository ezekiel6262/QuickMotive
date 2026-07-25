import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/client";
import { renderEndlessRunner } from "./templates/endless-runner";
import { renderPlatformer } from "./templates/platformer";
import { renderMatch3 } from "./templates/match3";

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "quickmotive-assets";

export const GAME_TEMPLATES = ["endless_runner", "platformer", "match_3"] as const;
export type GameTemplateId = (typeof GAME_TEMPLATES)[number];

const RENDERERS: Record<GameTemplateId, (params: { title: string; characterImageUrl: string }) => string> = {
  endless_runner: renderEndlessRunner,
  platformer: renderPlatformer,
  match_3: renderMatch3
};

/**
 * S11: builds a self-hosted, self-contained HTML5/Canvas game from one of
 * three fixed templates, skinned with the buyer's character art, and
 * uploads it to Supabase Storage as a single static HTML file. No
 * third-party game-hosting API -- replaces Higgsfield's
 * deploy_game/publish_game entirely.
 */
export async function buildGame(params: {
  template: GameTemplateId;
  characterImageUrl: string;
  title: string;
}): Promise<{ playUrl: string }> {
  const renderer = RENDERERS[params.template];
  const html = renderer({ title: params.title, characterImageUrl: params.characterImageUrl });

  const path = `games/${randomUUID()}.html`;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, html, {
    contentType: "text/html",
    upsert: true
  });
  if (error) throw new Error(`Failed to upload game: ${error.message}`);

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return { playUrl: data.publicUrl };
}
