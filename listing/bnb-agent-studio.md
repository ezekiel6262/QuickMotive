# BNB Agent Studio — listing submission

Copy for the BNB Agent Studio submission at
<https://www.bnbchain.org/en/bnb-agent-studio>.

**Before pasting:** finish `docs/bnb-agent-deployment.md` steps 1–3. A
listing that points at an agent card with no `registrations` and no
`payTo` reads as an unfinished submission. Run `npm run verify:pricing`
and `npm run verify:tokens` too — the prices below are generated from the
registry, and a failing check means they are wrong.

The exact field names on the submission form could not be checked from
this environment (bnbchain.org is blocked by the network egress policy
here), so this is organized by what any agent listing asks for rather than
by form field. Map it across as you go.

---

## Identity

**Name:** QuickMotive

**Tagline:** The creative and NFT-intelligence desk for autonomous agents.

**Category:** AI / Creative tooling / NFT infrastructure

**Agent card:** `https://<origin>/.well-known/agent-card.json`
**MCP endpoint:** `https://<origin>/api/mcp`
**ERC-8004 registration:** `eip155:56:<registry address>` token `<agentId>`
**Settlement:** b402 (x402 on BNB Smart Chain), USDT or USDC, paid to
`<AGENT_PAYOUT_ADDRESS>`

## Short description (~200 chars)

Eleven individually priced creative and NFT skills for agents: image and
video generation, brand-locked batch production, trait-based generative
art, on-chain collection scanning, and marketplace-ready export.

## Long description

QuickMotive is a service provider, not a chatbot. It exposes eleven
narrow, individually callable, individually priced skills over MCP, so a
calling agent buys exactly the one capability it is missing instead of
delegating a whole workflow to another generalist.

It covers the gap most agent marketplaces leave open. Trading, data, and
research agents are well served; the agent that needs a *picture* — a
collection generated to a brand's palette, a still turned into a video, a
10k PFP set deduplicated by trait hash, a rarity report as a PDF — has
nowhere to route that call. QuickMotive is that route.

Every skill runs standalone. There is no required orchestration layer, no
session to establish, and no bundle to buy: an agent that only ever needs
rarity reports pays only for rarity reports.

**What it does**

- *Generate* — images from a description (Gemini), video from a still or a
  prompt (Veo), variations from a source image at a controllable
  similarity strength (Stability).
- *Stay on brand* — define a palette / typography / logo / style-reference
  kit once, and every later generation call pulls those constraints, with
  automated QC flagging drift.
- *Produce at collection scale* — decompose a brief into a trait taxonomy,
  build a layered trait library, composite full collections, and hash-dedup
  every issued combination so no two tokens collide.
- *Read the chain* — enumerate an NFT collection's tokens and traits,
  compute rarity, and return both structured JSON and a rendered PDF
  report.
- *Ship the output* — marketplace-correct image formats, metadata JSON,
  social and print crops in one call; or skin one of three self-hosted
  HTML5 game templates with a character and publish a playable URL.

**How it charges**

Per call, over b402. The agent hits an endpoint, gets a 402 with the price
in USDT or USDC, signs an EIP-712 authorization, and retries; settlement
goes through the b402 relayer, so the buyer spends no gas. Prices range
from $0.05 to $3.00 depending on the skill. Nothing is charged until the
payment verifies, and settlement only runs after the work succeeds — a
failed job takes no money at all.

Where a call delivers less than it was billed for, the difference is
credited back to the paying wallet and applied to its next call
automatically.

## Skill catalog

| Skill | What it does | Price |
|---|---|---|
| `s1_prompt_bridge` | Media → structured reusable prompt, or text → image | 0.05 / call |
| `s1_prompt_bridge` (video) | Text → video, same endpoint | 0.24 / second |
| `s2_image_to_motion` | Animate a still image, optional motion direction | 0.24 / second (4, 6 or 8s) |
| `s3_design_tweak` | Plain-language edit applied to a Canva design or raster asset | 0.15 / call |
| `s4_nft_scanner_report` | On-chain collection scan → rarity + PDF report | 2.00 / call |
| `s5_brand_kit` | Define a reusable brand-lock kit | 0.10 / call |
| `s6_nft_image_gen` | Generate a styled image set from a description | 0.30 / delivered asset |
| `s7_nft_variation` | img2img variations with per-image similarity scoring | 0.30 / delivered asset |
| `s8_batch_generation` | Brand-constrained batch with QC gating | 0.35 / QC-passing asset |
| `s9_export_bundle` | Marketplace/social/print/web export + metadata | 0.20 / call |
| `s10_trait_engine` | Trait taxonomy → layered library → deduped collection | 0.50 / issued token |
| `s11_game_template` | Playable HTML5 game skinned with a character | 3.00 / call |

All amounts in USDT (or USDC at the same nominal price). Live schemas and
prices: `GET https://<origin>/api/mcp` or the agent card.

**On "delivered".** x402's `exact` scheme fixes the amount before the work
runs, so the request is authorized for the count asked for. Whatever isn't
delivered — an asset that fails QC, a token rejected as a duplicate, a
video Veo returns shorter than requested — is credited back to the paying
wallet and applied automatically to its next call. The buyer pays for what
they receive; the credit balance is the mechanism, and it is visible in
every response's `payment` object.

## Trust and limits

Worth stating plainly in the submission rather than being discovered by a
buyer:

- Trust model is client feedback (ERC-8004 reputation). No validator or
  TEE attestation is claimed.
- QC checks (palette drift, dominant colour) are approximate — flagged
  output means "worth a look", not a guaranteed pass/fail.
- S10 dedup is guaranteed only within one collection's combinatorial
  space.
- Large on-chain scans (10k+ tokens) are paginated and cached but bounded
  by upstream rate limits.
- S2 video generation takes 30s–2min and currently polls inside one
  request; long jobs can exceed a serverless timeout.

## Links

- Agent card: `https://<origin>/.well-known/agent-card.json`
- MCP endpoint: `https://<origin>/api/mcp`
- Repository: https://github.com/ezekiel6262/quickmotive
- Contact: (submission account email)
