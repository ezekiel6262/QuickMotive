# QuickMotive -- OKX.ai Creative & NFT Agent Suite

An Agent Service Provider (ASP) exposing a portfolio of narrow, individually
callable creative and NFT-analysis skills via A2MCP (pay-per-call), so each
service earns independently instead of shipping as one monolithic agent.

Positioning: the creative + NFT-intelligence desk on OKX.ai -- complements
pure trading/data agents (CoinAnk, CertiK, etc.) by covering the media and
visual-analysis gap.

## Architecture

```
                         OKX.ai (Agent Marketplace)
                                   |
                    Agentic Wallet (onchain identity, USDT/USDG)
                                   |
                A2MCP endpoints (one per service, priced individually)
                                   |
                Orchestrator (Claude API, tool use) -- optional
                                   |
   -------------------------------------------------------------------
   |                |                  |                  |          |
Media gen      Design edit      On-chain scan       Generative-art  Report
(Gemini image, (Canva Connect   (Moralis/Covalent)   engine (trait  gen (PDF)
Higgsfield     API)                                  taxonomy +
video/motion)                                        hash dedup)
        |
   Brand-lock store (palette/type/logo/style refs) -- every generation
   call above can optionally pull constraints from here
```

Every service is its own Next.js route handler under
`app/api/services/<service>/route.ts`, backed by shared libs in `lib/`. None
of them depend on the orchestrator to function -- `app/api/orchestrator`
exists only as a "describe a goal, let Claude chain the right tools"
convenience entry point, itself billed as the `orchestrator` service_type.

## Services (S1-S11)

The full catalog, with JSON Schema input/output and pricing, is defined in
`lib/a2mcp/registry.ts` and served live at `GET /api/a2mcp/tools`. Summary:

| ID  | Service | Route |
|-----|---------|-------|
| S1  | Image/video <-> text prompting | `/api/services/s1-prompt-bridge` |
| S2  | Video motion from a single image | `/api/services/s2-image-to-motion` |
| S3  | Graphic design smart edit | `/api/services/s3-design-tweak` |
| S4  | On-chain NFT scanner + PDF report | `/api/services/s4-nft-scanner-report` |
| S5  | Brand-lock kit definition | `/api/services/s5-brand-kit` |
| S6  | NFT image generation from description | `/api/services/s6-nft-image-gen` |
| S7  | NFT variation from a source image | `/api/services/s7-nft-variation` |
| S8  | Batch generation with QC gating | `/api/services/s8-batch-generation` |
| S9  | NFT-ready multi-format export | `/api/services/s9-export-bundle` |
| S10 | Trait-based generative art engine | `/api/services/s10-trait-engine` |
| S11 | Templated game from a character | `/api/services/s11-game-template` |

Build sequence followed section 8 of the original brief: S4/S1 first
(reuse-heavy, validates payment flow), then S5 (brand-lock, so S6/S7/S8
don't need reworking later), then S2/S3/S6/S7, then S9, then S8/S10, then
S11.

## Tech stack

- Next.js 14 (App Router) + TypeScript
- Google Gemini API (`gemini-2.5-flash-image` / "Nano Banana") for all image
  generation -- direct integration, not through Higgsfield, on cost grounds
- Higgsfield REST API for video/motion/outpaint/background-removal/upscale/
  reframe/game creation (image generation moved off it, see above)
- Anthropic SDK (`@anthropic-ai/sdk`) for prompt extraction (S1), edit
  planning (S3), and the orchestrator's tool-use loop
- `sharp` for server-side image compositing (S10), export resizing (S9),
  and QC checks (S8)
- `pdf-lib` for the shared cover+grid PDF renderer (S4, S10)
- Supabase (Postgres + Storage) for job/metadata records and generated
  assets, matching the Merqt/Qwibi pattern
- OKX Agentic Wallet + OnchainOS A2MCP for identity/settlement

## Data model

See `supabase/migrations/0001_init.sql`. Every A2MCP call creates one row in
`jobs` (the audit/settlement anchor) via `lib/jobs.ts`'s `withJob` helper,
regardless of which service handled it.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in real credentials
npm run typecheck
npm run dev
```

Apply the migration to a Supabase project (`supabase db push` or paste
`supabase/migrations/0001_init.sql` into the SQL editor) before exercising
any route that touches the database.

## OKX.ai integration checklist

- [ ] Set up OKX Agentic Wallet for the ASP identity (email required)
- [ ] Register as Agent Service Provider via OnchainOS
- [ ] Register each A2MCP tool schema from `GET /api/a2mcp/tools` (one per
      service, priced individually per `lib/a2mcp/registry.ts`)
- [ ] Set spending limits/allowlists as required by the platform
- [ ] Confirm settlement currency (USDT or USDG) and payout wallet
      (`OKX_SETTLEMENT_CURRENCY` in `.env`) -- `GET /api/admin/okx-balance`
      checks the configured settlement currency actually shows up in the
      OKX account balance via the exchange API (see below)
- [ ] Test each service standalone via its route before bundling into a
      combined listing

### OKX exchange API vs. Agentic Wallet/OnchainOS

Two separate OKX integration points, easy to conflate:

- **OKX exchange API (v5)**: `OKX_API_KEY` / `OKX_SECRET_KEY` /
  `OKX_PASSPHRASE`, from OKX's regular exchange API dashboard. Wired via
  `lib/clients/okx.ts` (HMAC-SHA256 signed requests) and used by
  `GET /api/admin/okx-balance` to confirm the settlement currency is
  actually present in the account -- an ops check, not a buyer-facing
  A2MCP tool. Unauthenticated route; add real access control before
  relying on it outside manual testing.
- **OKX Agentic Wallet / OnchainOS ASP registration**: a platform-side
  setup step (wallet identity, ASP registration, tool schema registration)
  done through OKX.ai/OnchainOS directly, not something this app
  authenticates to via API credentials.

## Known integration gaps

These are places where the build brief assumed an interactive-agent MCP
tool shape that doesn't match what a headless backend can call, or where a
public API contract needs confirming before go-live:

- **Higgsfield**: `lib/clients/higgsfield.ts` was originally guessed
  (Bearer auth, `POST /v1/generate_image`, synchronous response) and
  confirmed wrong against a live deployment (404, since the configured URL
  was actually Higgsfield's separate MCP endpoint). Rewritten against the
  official JS SDK source (github.com/higgsfield-ai/higgsfield-js): base URL
  `https://platform.higgsfield.ai`, auth header `Authorization: Key
  KEY_ID:KEY_SECRET` (not Bearer), model-slug-based endpoints
  (`POST /v1/{modelSlug}`), async submit-then-poll
  (`GET /requests/{id}/status`). All image generation has since moved off
  Higgsfield onto Gemini (see below) on cost grounds -- Higgsfield remains
  wired only for video/motion/outpaint/background-removal/upscale/
  reframe/game creation, all still using placeholder model slugs marked
  `UNVERIFIED` in the client and likely to 404 the same way the image
  endpoint did until confirmed against Higgsfield's model catalog. Also
  unconfirmed: whether polling completes within a single Vercel function's
  timeout for slower jobs (video especially) -- the SDK's `hf_webhook`
  callback is the probable fix.
- **Gemini** (`lib/clients/gemini.ts`, `gemini-2.5-flash-image` / "Nano
  Banana"): handles image generation for S1 text-to-image, S6, S8, and
  S10's trait library, as a direct, cheaper replacement for Higgsfield.
  Confirmed against Google's docs/cookbook before wiring (unlike the first
  Higgsfield pass), but still untested live end-to-end as of this writing
  -- confirm a real `GEMINI_API_KEY` call succeeds before relying on it.
  Known gaps: free-tier rate limits aren't accounted for in the parallel
  `Promise.all` fan-outs in S6/S8/S10 (a burst of concurrent calls could
  429); no handling yet for `promptFeedback` safety blocks beyond
  surfacing the error.
- **fal.ai / Qwen-Image** (`lib/clients/fal.ts`, S7 only): Gemini has no
  numeric img2img "strength" parameter, so S7 (NFT variation, which
  specifically needs one) uses `fal-ai/qwen-image/image-to-image` instead
  via fal.ai's queue API -- confirmed real `strength` semantics (0 =
  preserve original, 1 = fully remake) against the model's published input
  schema. Pay-per-use, not a subscription. Still untested live as of this
  writing -- confirm a real `FAL_API_KEY` call succeeds before relying on
  it. This is the only service using fal.ai; everything else stays on
  Gemini or Higgsfield.
- **Canva**: the brief assumed a
  `start-editing-transaction -> perform-editing-operations -> commit-editing-transaction`
  flow. Canva's actual tool is a single `edit-design` call keyed by a
  `transaction_id` from `read-design(open_transaction: true)`, with a
  `finalize` field (`keep_open` / `commit` / `cancel`). `lib/clients/canva.ts`
  models the real shape; confirm Connect API scopes
  (`design:content:write`, `design:meta:read`, `asset:write`) before go-live.
- **S10 segmentation**: "decompose source image into a trait taxonomy" is
  implemented as a vision-model description (`proposeTraitTaxonomy` in
  `lib/clients/anthropic.ts`), not true image segmentation. It's a
  reasonable starting taxonomy, not a pixel-accurate decomposition.
- **S8/S10 QC checks** (`lib/qc.ts`, `lib/brand-kit.ts`
  `checkPaletteDrift`): dominant-color extraction is a coarse 4x4-grid
  sample, not a proper clustering algorithm. Tune before relying on it for
  buyer-facing pass/fail decisions.
- **On-chain data** (`lib/clients/onchain.ts`): implements Moralis directly.
  If Qwibi already has a Moralis/Covalent client, prefer importing that
  instead -- this exists so S4 is buildable and testable standalone per the
  brief.

## Open risks (carried over from the build brief)

- Higgsfield generation cost per call needs to be priced into each A2MCP
  listing -- confirm credit cost per image/video/motion call before setting
  buyer-facing prices in `lib/a2mcp/registry.ts` (current `amount` values
  are placeholders).
- Canva editing requires the design to already live in Canva or be
  importable -- not every buyer will have that (S3 handles this via
  `design_import_url` as a fallback, but import can still fail for
  non-Canva-native formats).
- S10 dedup only works within a single collection's combinatorial space.
  `generateNonRepeatingToken` fails gracefully (returns `null`, caller stops
  and reports `rejected_collisions`) rather than looping forever when the
  trait library can't cover the requested collection size.
- On-chain scans on large collections (10k+ tokens) will hit rate limits on
  Moralis/Covalent. `lib/clients/onchain.ts` builds in cursor pagination and
  a 5-minute in-memory TTL cache from day one.
- Brand-kit QC checks are approximate, not exact -- flagged outputs are
  "worth a look," not a guaranteed pass/fail. Set buyer expectations in the
  A2MCP listing copy to avoid disputes over borderline cases.
- S8 batch generation has variable output count (some requests land in the
  flagged pile). Pricing in the registry is `per_delivered_asset` for
  exactly this reason -- confirm this is how OKX's A2MCP settlement expects
  variable-count billing to work before go-live.
- NFT-ready export assumes marketplace spec norms that can change. Kept in
  `config/marketplace-specs.ts` as data, not hardcoded in `lib/export-bundle.ts`,
  so a marketplace spec update is a config change, not a code change.
