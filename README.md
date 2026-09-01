# QuickMotive -- Creative & NFT Agent Suite

An Agent Service Provider (ASP) exposing a portfolio of narrow, individually
callable creative and NFT-analysis skills (pay-per-call), so each service
earns independently instead of shipping as one monolithic agent.

Positioning: the creative + NFT-intelligence desk -- complements pure
trading/data agents (CoinAnk, CertiK, etc.) by covering the media and
visual-analysis gap.

The same eleven services are sold through two marketplaces, over two
transports, from one implementation:

- **OKX.ai** via A2MCP, settled by OKX Agentic Wallet / OnchainOS.
- **BNB Chain** (BNB Agent Studio, Yellow Crab) via MCP + an ERC-8004
  on-chain identity, settled per call in USDT/USDC over x402/b402. See
  [`docs/bnb-agent-deployment.md`](docs/bnb-agent-deployment.md).

The BNB payment gate is off unless `X402_ENABLED=true`, so the OKX
deployment behaves exactly as it did before that path existed.

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
Veo video,     API)                                  taxonomy +
Stability edit)                                      hash dedup)
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
- Google Veo (`veo-3.1-fast-generate-preview`, same Gemini API key) for all
  video generation (S1's video path, S2) -- not free-tier, real per-second
  pricing in `lib/clients/veo.ts`
- Stability AI Developer Platform for img2img strength (S7), non-destructive
  raster region edits (S3), and background removal (S10's trait library)
- No Higgsfield dependency anywhere in this suite anymore. S11 (game
  creation) is fully self-hosted: `lib/games/templates/` has three
  self-contained HTML5/Canvas game pages (endless runner, platformer,
  match-3), skinned with the buyer's character art and uploaded to
  Supabase Storage as static files -- no third-party game API
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

## BNB Chain deployment

Full runbook: [`docs/bnb-agent-deployment.md`](docs/bnb-agent-deployment.md).
Listing copy: [`listing/bnb-agent-studio.md`](listing/bnb-agent-studio.md),
[`listing/yellowcrab.md`](listing/yellowcrab.md).

```
  /.well-known/agent-card.json   A2A AgentCard + ERC-8004 registration file,
                                 built from lib/a2mcp/registry.ts
  /api/mcp                       MCP JSON-RPC: initialize, tools/list,
                                 tools/call -> proxies to the same service
                                 routes a direct HTTP buyer hits
  lib/payments/x402.ts           402 -> verify -> work -> settle, per call
  scripts/register-agent.ts      ERC-8004 identity mint (dry-run default)
  scripts/verify-agent.ts        pre-submission smoke test
```

```bash
npm test                                   # money arithmetic (no network)
npm run verify:pricing                     # nothing sold below provider cost
npm run verify:tokens                      # token table vs. chain + facilitator
npm run agent:verify -- https://<origin>   # what a reviewer/indexer will hit
npm run agent:register                     # preflight + simulate, sends nothing
npm run agent:register -- --confirm        # broadcast the registration
```

Pricing is derived from provider costs (`lib/pricing/costs.ts`), and
under-delivery is credited back to the paying wallet rather than kept
(`lib/payments/credits.ts`, migration `0002`) -- x402's `exact` scheme
settles a fixed amount decided before the work runs, so the credit ledger
is what makes "per delivered asset" true.

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

- **BNB / x402 path**: the payment wire format follows the x402 v1 spec
  that b402 implements, but has not been exercised against a live
  facilitator -- run one testnet payment before mainnet
  (`npm run verify:tokens` checks the chain-side constants and the
  facilitator's `/supported` in the meantime). The orchestrator is
  unmetered and refuses to run while payments are on. Both, and the
  mechanisms behind the two pricing fixes below, are written up in
  [`docs/bnb-agent-deployment.md`](docs/bnb-agent-deployment.md).
- **Higgsfield -- fully removed**: `lib/clients/higgsfield.ts` was
  originally guessed (Bearer auth, `POST /v1/generate_image`, synchronous
  response) and confirmed wrong against a live deployment (404, since the
  configured URL was actually Higgsfield's separate MCP endpoint).
  Rewritten against the official JS SDK source
  (github.com/higgsfield-ai/higgsfield-js), then phased out entirely on
  cost grounds: image generation moved to Gemini, video moved to Veo,
  img2img/outpaint/background-removal moved to Stability AI, S11 rebuilt
  as self-hosted static templates (all below). The client file itself has
  been deleted -- nothing in this repo depends on Higgsfield anymore.
- **Gemini** (`lib/clients/gemini.ts`, `gemini-2.5-flash-image` / "Nano
  Banana"): handles image generation for S1 text-to-image, S6, S8, and
  S10's trait library, as a direct, cheaper replacement for Higgsfield.
  Confirmed against Google's docs/cookbook before wiring (unlike the first
  Higgsfield pass). **Confirmed working live** (S1 end-to-end tested
  against the deployed app). Known gaps: free-tier rate limits aren't
  accounted for in the parallel `Promise.all` fan-outs in S6/S8/S10 (a
  burst of concurrent calls could 429); no handling yet for
  `promptFeedback` safety blocks beyond surfacing the error.
- **Veo** (`lib/clients/veo.ts`, `veo-3.1-fast-generate-preview`): replaces
  Higgsfield for S1's video path and S2 (video motion). Same Gemini API
  key as image generation, different model -- confirmed request/response
  shape against multiple independent sources (Google AI Developer forum,
  Google Cloud docs). Untested live as of this writing. Two real risks
  worth reading before relying on this:
  - **Cost**: standard Veo 3.1 is $0.40/sec ($3.20 for an 8s clip); this
    client defaults to the "fast" tier (~$0.10-0.15/sec, ~$0.75-1.20 for
    8s) to stay closer to the rest of this suite's cost profile, but
    that's still well above S2's current flat $0.40/call placeholder
    price in `lib/a2mcp/registry.ts` -- that price needs revisiting before
    go-live, not just the model tier.
  - **Timeout**: video generation commonly takes 30s-2min+, and this
    client polls synchronously inside a single request (for consistency
    with this suite's other providers). That will likely exceed Vercel's
    default serverless function timeout. Needs a webhook or async-job
    redesign (return `job_id` immediately, poll a separate status
    endpoint) before relying on it in production.
- **Stability AI** (`lib/clients/stability.ts`): three operations, all
  confirmed against a third-party proxy mirroring Stability's own
  parameters plus search-indexed doc snippets, since Stability's docs
  pages 403'd automated fetches the same as several other vendors' did.
  - `imageToImage` (S7): Gemini has no numeric img2img "strength"
    parameter -- it's architecturally incapable of this, not just
    unconfigured (strength is a diffusion-sampling parameter; see the
    header comment in `lib/clients/gemini.ts`). Uses `sd3.5-medium` via
    `POST /v2beta/stable-image/generate/sd3`. **Confirmed working live**
    (S7 end-to-end tested against the deployed app).
  - `editBackgroundRegion` (S3's raster path): the original Higgsfield
    call here (`outpaintImage` with `aspectRatio: "auto"`) never actually
    matched the use case -- outpaint extends canvas outward, it doesn't
    edit an existing region, which is what "make the background blue"
    style instructions need. Replaced with a composed pipeline: cut out
    the foreground (`edit/remove-background`), invert its alpha channel
    into a mask, then `edit/inpaint` with that mask + the buyer's
    instruction -- so only the background changes and the subject stays
    pixel-identical. Untested live as of this writing.
  - `removeBackground` (S10's trait library): `edit/remove-background`.
    Untested live as of this writing.
  - Note: Stability AI "Brand Studio" credits are a separate product from
    the Developer Platform for most account tiers (Brand Studio API
    access is Enterprise-only) -- confirmed in this case that the
    account's credits do cover `api.stability.ai` directly.
  (An earlier pass wired S7 via fal.ai's Qwen-Image instead, before
  switching to Stability for its free credits -- fal.ai remains a fallback
  worth reconsidering if Stability credits run out.)
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
- **S11 game templates** (`lib/games/`): rebuilt from scratch as
  self-hosted static HTML5/Canvas pages instead of depending on any
  third-party game-hosting API. Three templates (`endless_runner`,
  `platformer`, `match_3`), each a self-contained page skinned with the
  buyer's character art via `<img>` src, uploaded to Supabase Storage as
  a single `.html` file (`games/{uuid}.html`) and returned as the
  `play_url`. Verified locally: generated each template with a test image
  URL and loaded it in headless Chromium -- no JS runtime errors, and each
  template's image-load-failure fallback (colored rectangle in place of
  the character) renders correctly when the character image can't load.
  Not yet tested against a real deployed character asset URL. Known
  simplifications: match-3 does a single clear-and-refill pass with no
  cascade re-matching; the platformer has one fixed layout, no level
  variation; none of the three persist high scores or send completion
  events back to the backend.

## Open risks (carried over from the build brief)

- Provider cost per call is no longer a placeholder for the paths where a
  cost is known: `lib/pricing/costs.ts` holds provider unit costs as data
  and derives buyer-facing prices from them, and `npm run verify:pricing`
  fails if any service is priced below cost. This closed two real holes --
  S2's flat $0.40/call against a Veo clip costing up to $1.20, and S1's
  video path running the same Veo call behind a $0.05 flat price. The
  remaining `amount` values (Gemini- and Stability-backed services) are
  still placeholders: they have no `costBasis` entry, so the check passes
  them silently. Add their costs to the table once confirmed.
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
  variable-count billing to work before go-live. On the BNB path this is
  handled: x402 authorizes the requested count up front, and
  `payment.reconcile(delivered)` credits the difference back to the paying
  wallet (`lib/payments/credits.ts`). The same applies to S10's rejected
  collisions and to a Veo clip returned shorter than requested.
- NFT-ready export assumes marketplace spec norms that can change. Kept in
  `config/marketplace-specs.ts` as data, not hardcoded in `lib/export-bundle.ts`,
  so a marketplace spec update is a config change, not a code change.
