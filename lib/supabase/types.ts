/**
 * Hand-maintained mirror of supabase/migrations/0001_init.sql.
 * Regenerate with `supabase gen types typescript` once a live project
 * exists and keep this file as the checked-in fallback.
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "flagged";
export type QcStatus = "pending" | "pass" | "flagged";
export type ServiceType =
  | "s1_prompt_bridge"
  | "s2_image_to_motion"
  | "s3_design_tweak"
  | "s4_nft_scanner_report"
  | "s5_brand_kit"
  | "s6_nft_image_gen"
  | "s7_nft_variation"
  | "s8_batch_generation"
  | "s9_export_bundle"
  | "s10_trait_engine"
  | "s11_game_template"
  | "orchestrator";

export interface JobRow {
  id: string;
  service_type: ServiceType;
  buyer_wallet: string;
  status: JobStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  price_paid: number | null;
  price_currency: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaAssetRow {
  id: string;
  job_id: string;
  type: "image" | "video" | "prompt" | "design_export";
  url: string | null;
  source_prompt: string | null;
  metadata: Record<string, unknown>;
  brand_kit_id: string | null;
  qc_status: QcStatus;
  qc_reason: string | null;
  created_at: string;
}

export interface NftScanRow {
  id: string;
  job_id: string;
  contract_address: string;
  chain: string;
  collection_name: string | null;
  token_count: number | null;
  floor_price: number | null;
  volume_24h: number | null;
  report_pdf_url: string | null;
  created_at: string;
}

export interface NftTokenRow {
  id: string;
  scan_id: string;
  token_id: string;
  image_url: string | null;
  traits: Array<{ trait_type: string; value: string }>;
  rarity_score: number | null;
  created_at: string;
}

export interface TraitLibraryRow {
  id: string;
  collection_id: string;
  category: string;
  option_name: string;
  asset_url: string;
  weight: number;
  created_at: string;
}

export interface IssuedComboRow {
  id: string;
  collection_id: string;
  trait_hash: string;
  token_id: string | null;
  created_at: string;
}

export interface BrandKitRow {
  id: string;
  buyer_wallet: string;
  name: string;
  palette: Array<{ hex: string; role: string }>;
  typography: Record<string, unknown>;
  logo_urls: string[];
  style_ref_urls: string[];
  tone_descriptors: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExportBundleRow {
  id: string;
  media_asset_id: string;
  target: string;
  file_url: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      jobs: { Row: JobRow; Insert: Partial<JobRow>; Update: Partial<JobRow> };
      media_assets: {
        Row: MediaAssetRow;
        Insert: Partial<MediaAssetRow>;
        Update: Partial<MediaAssetRow>;
      };
      nft_scans: { Row: NftScanRow; Insert: Partial<NftScanRow>; Update: Partial<NftScanRow> };
      nft_tokens: { Row: NftTokenRow; Insert: Partial<NftTokenRow>; Update: Partial<NftTokenRow> };
      trait_library: {
        Row: TraitLibraryRow;
        Insert: Partial<TraitLibraryRow>;
        Update: Partial<TraitLibraryRow>;
      };
      issued_combos: {
        Row: IssuedComboRow;
        Insert: Partial<IssuedComboRow>;
        Update: Partial<IssuedComboRow>;
      };
      brand_kits: { Row: BrandKitRow; Insert: Partial<BrandKitRow>; Update: Partial<BrandKitRow> };
      export_bundles: {
        Row: ExportBundleRow;
        Insert: Partial<ExportBundleRow>;
        Update: Partial<ExportBundleRow>;
      };
    };
  };
}
