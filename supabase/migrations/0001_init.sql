-- QuickMotive / OKX.ai Creative & NFT Agent Suite
-- Core data model for the ASP: jobs, generated assets, on-chain scans,
-- trait libraries, brand kits, and export bundles.
-- See section 6 of the build brief for the indicative shape this extends.

create extension if not exists "pgcrypto";

create type job_status as enum ('queued', 'running', 'succeeded', 'failed', 'flagged');
create type qc_status as enum ('pending', 'pass', 'flagged');
create type service_type as enum (
  's1_prompt_bridge',
  's2_image_to_motion',
  's3_design_tweak',
  's4_nft_scanner_report',
  's5_brand_kit',
  's6_nft_image_gen',
  's7_nft_variation',
  's8_batch_generation',
  's9_export_bundle',
  's10_trait_engine',
  's11_game_template',
  'orchestrator'
);

-- Every A2MCP call lands one row here, regardless of which service handled it.
-- This is the settlement/audit anchor: price_paid is what OKX Agentic Wallet
-- charged the buyer for this call.
create table jobs (
  id uuid primary key default gen_random_uuid(),
  service_type service_type not null,
  buyer_wallet text not null,
  status job_status not null default 'queued',
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  price_paid numeric(20, 6),
  price_currency text default 'USDT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_buyer_wallet_idx on jobs (buyer_wallet);
create index jobs_service_type_idx on jobs (service_type);
create index jobs_status_idx on jobs (status);
create index jobs_created_at_idx on jobs (created_at desc);

-- Brand-lock kits (S5). Reused across S1, S6, S7, S8 generation calls.
-- Declared before media_assets, which references it.
create table brand_kits (
  id uuid primary key default gen_random_uuid(),
  buyer_wallet text not null,
  name text not null,
  palette jsonb not null default '[]'::jsonb, -- [{ "hex": "#112233", "role": "primary" }, ...]
  typography jsonb not null default '{}'::jsonb,
  logo_urls jsonb not null default '[]'::jsonb,
  style_ref_urls jsonb not null default '[]'::jsonb,
  tone_descriptors text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index brand_kits_buyer_wallet_idx on brand_kits (buyer_wallet);

-- Generated or transformed media (S1, S2, S3, S6, S7, S8, part of S10).
create table media_assets (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs (id) on delete cascade,
  type text not null, -- image | video | prompt | design_export
  url text,
  source_prompt text,
  metadata jsonb not null default '{}'::jsonb,
  brand_kit_id uuid references brand_kits (id) on delete set null,
  qc_status qc_status not null default 'pending',
  qc_reason text,
  created_at timestamptz not null default now()
);
create index media_assets_job_id_idx on media_assets (job_id);
create index media_assets_brand_kit_id_idx on media_assets (brand_kit_id);
create index media_assets_qc_status_idx on media_assets (qc_status);

-- On-chain collection scans (S4).
create table nft_scans (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs (id) on delete cascade,
  contract_address text not null,
  chain text not null,
  collection_name text,
  token_count integer,
  floor_price numeric(20, 8),
  volume_24h numeric(20, 8),
  report_pdf_url text,
  created_at timestamptz not null default now()
);
create index nft_scans_contract_chain_idx on nft_scans (contract_address, chain);
create index nft_scans_job_id_idx on nft_scans (job_id);

create table nft_tokens (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references nft_scans (id) on delete cascade,
  token_id text not null,
  image_url text,
  traits jsonb not null default '[]'::jsonb,
  rarity_score numeric(10, 4),
  created_at timestamptz not null default now(),
  unique (scan_id, token_id)
);
create index nft_tokens_scan_id_idx on nft_tokens (scan_id);

-- Trait-based generative art engine (S10).
create table trait_library (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null,
  category text not null,
  option_name text not null,
  asset_url text not null,
  weight numeric(6, 4) not null default 1.0,
  created_at timestamptz not null default now(),
  unique (collection_id, category, option_name)
);
create index trait_library_collection_id_idx on trait_library (collection_id);

-- Dedup ledger: one row per issued trait combination per collection.
create table issued_combos (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null,
  trait_hash text not null,
  token_id text,
  created_at timestamptz not null default now(),
  unique (collection_id, trait_hash)
);
create index issued_combos_collection_id_idx on issued_combos (collection_id);

-- Multi-format export packaging (S9), one row per target produced from a
-- source asset in a single bundle.
create table export_bundles (
  id uuid primary key default gen_random_uuid(),
  media_asset_id uuid not null references media_assets (id) on delete cascade,
  target text not null, -- marketplace:<name> | social:<platform> | print | web
  file_url text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index export_bundles_media_asset_id_idx on export_bundles (media_asset_id);

-- updated_at maintenance
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger jobs_set_updated_at before update on jobs
  for each row execute function set_updated_at();

create trigger brand_kits_set_updated_at before update on brand_kits
  for each row execute function set_updated_at();
