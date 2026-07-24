/**
 * Marketplace/social/print export specs, kept as data rather than hardcoded
 * in S9's logic -- per the brief's risk note, marketplace norms change and
 * this should be a config update, not a code change.
 */
export interface ExportSpec {
  target: string;
  width: number;
  height: number;
  format: "png" | "jpg" | "webp";
  maxFileSizeKb?: number;
}

export const MARKETPLACE_SPECS: Record<string, ExportSpec> = {
  opensea: { target: "marketplace:opensea", width: 2000, height: 2000, format: "png" },
  magiceden: { target: "marketplace:magiceden", width: 2000, height: 2000, format: "png" },
  blur: { target: "marketplace:blur", width: 1500, height: 1500, format: "png" }
};

export const DEFAULT_MARKETPLACE = "opensea";

export const SOCIAL_CROP_SPECS: Record<string, ExportSpec> = {
  instagram_post: { target: "social:instagram_post", width: 1080, height: 1350, format: "jpg" },
  instagram_story: { target: "social:instagram_story", width: 1080, height: 1920, format: "jpg" },
  twitter_post: { target: "social:twitter_post", width: 1600, height: 900, format: "jpg" }
};

export const PRINT_SPEC: ExportSpec = { target: "print", width: 3600, height: 3600, format: "png" };

export const WEB_SPEC: ExportSpec = { target: "web", width: 1200, height: 1200, format: "webp", maxFileSizeKb: 300 };
