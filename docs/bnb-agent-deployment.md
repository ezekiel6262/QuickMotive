# Deploying QuickMotive as a BNB Chain agent

Runbook for taking this repo from "Next.js app" to "agent with an on-chain
identity that earns in stablecoins on BNB Smart Chain", then listing it on
BNB Agent Studio and Yellow Crab.

The OKX.ai A2MCP path is unaffected. The same eleven services are sold
through both marketplaces; the BNB path adds an agent card, an MCP
endpoint, and an x402/b402 payment gate that is **off by default**
(`X402_ENABLED` unset), so nothing here changes existing behavior until you
turn it on.

## What was built

| Piece | Where | What it does |
|---|---|---|
| Agent card | `lib/agent/card.ts`, served at `/.well-known/agent-card.json` | One document that is both an A2A AgentCard and an ERC-8004 registration file. All eleven skills, their JSON Schemas, and their prices, derived from `lib/a2mcp/registry.ts`. |
| Domain proof | `/.well-known/agent-registration.json` | ERC-8004's optional hostname-control proof. |
| MCP endpoint | `app/api/mcp/route.ts` | JSON-RPC `initialize` / `tools/list` / `tools/call`. Proxies to the same route handlers a direct HTTP buyer hits, so there is one implementation and one payment gate per service. |
| Payment gate | `lib/payments/x402.ts` | x402 wire format, b402 settlement. Verify before doing work, settle after it succeeds. |
| Chain config | `lib/chains/bnb.ts` | Chain IDs, CAIP-2, relayer, and the settlement token table. |
| Registration | `scripts/register-agent.ts` | Mints the ERC-8004 identity. Dry-run by default. |
| Credit ledger | `lib/payments/credits.ts`, migration `0002` | Under-delivery becomes credit on the buyer's next call, since x402 `exact` cannot settle for less than it authorized. |
| Cost-derived pricing | `lib/pricing/costs.ts` | Provider costs as data; prices computed from them, not hand-set. |
| Pre-submission check | `scripts/verify-agent.ts` | Everything a marketplace reviewer or indexer will hit. |
| Pricing check | `scripts/verify-pricing.ts` | Fails if any service is priced below its provider cost. |
| Chain constants check | `scripts/verify-tokens.ts` | Reads `symbol()`/`decimals()` off each token contract; probes the facilitator's `/supported`. |

## How a paid call actually flows

```
buyer agent                  QuickMotive                 b402 facilitator      BSC
    |  POST /api/services/s6      |                            |                |
    |---------------------------->|                            |                |
    |  402 + accepts[]            |                            |                |
    |<----------------------------|                            |                |
    | (signs EIP-712 auth)        |                            |                |
    |  POST + X-PAYMENT           |                            |                |
    |---------------------------->|  /verify                   |                |
    |                             |--------------------------->|                |
    |                             |  isValid: true             |                |
    |                             |<---------------------------|                |
    |                             | (Gemini/Veo/Stability work happens here)    |
    |                             |  /settle                   |                |
    |                             |--------------------------->| relayer tx --->|
    |  200 + X-PAYMENT-RESPONSE   |<---------------------------|                |
    |<----------------------------|                            |                |
```

Two ordering decisions worth keeping:

- **Verify before work.** A bad signature costs zero provider spend.
- **Settle after work.** A failed job must not take the buyer's money, and
  a settlement error after a *successful* job is logged and reported as
  `payment.settled: false` rather than thrown — the buyer keeps the assets
  we already paid to generate, and the job row records what is owed.

## Step 1 — deploy

Deploy as normal (Vercel or equivalent) with the existing provider keys,
plus:

```
AGENT_BASE_URL=https://<your real https origin>
```

Use the production origin, not a preview URL: it ends up inside an on-chain
registration.

Leave `X402_ENABLED` unset for now. Confirm:

```bash
npm run agent:verify -- https://<your origin>
```

Expect the card, domain proof, MCP `initialize`, and `tools/list` to pass,
with the 402 check reporting that the gate is off.

## Step 2 — turn on payments

```
X402_ENABLED=true
AGENT_PAYOUT_ADDRESS=0x...        # where settlement lands
B402_NETWORK=bsc-mainnet
B402_ACCEPTED_CURRENCIES=USDT,USDC
```

Redeploy, then re-run `agent:verify`. The 402 check should now report a
real `accepts` entry, e.g. `exact on bsc-mainnet, 100000000000000000 of
0x55d3...7955`.

Then check the chain-side constants and the prices, both of which fail
loudly rather than needing to be eyeballed:

```bash
npm run verify:tokens     # symbol()/decimals() on-chain + facilitator /supported
npm run verify:pricing    # no service priced below its provider cost
npm test                  # the money arithmetic
```

`verify:tokens` is the one that matters most here. BEP-20 USDT and USDC on
BSC are **18-decimal**, unlike their 6-decimal Ethereum/Base counterparts,
so 0.10 USDT is `100000000000000000` — a `decimals` copied from an
Ethereum config misprices everything by 10^12, and a mistyped address
quotes buyers against the wrong contract entirely. The script reads both
off the chain instead of trusting the table.

Apply migration `0002_payment_credits.sql` before enabling payments — the
credit ledger is what stops under-delivering calls from over-charging.

## Step 3 — register the ERC-8004 identity

Set the registry address, having read it off the ERC-8004 deployment table
and confirmed it on BscScan:

```
ERC8004_IDENTITY_REGISTRY=0x...
AGENT_WALLET_ADDRESS=0x...
AGENT_PRIVATE_KEY=0x...            # local only, never in the app's env
BSC_RPC_URL=https://...            # optional; public dataseed rate-limits
```

Dry run first — it fetches the live card, checks the registry has
bytecode, checks the signer has gas, and simulates the mint without
broadcasting:

```bash
npm run agent:register
```

Then, once the dry run reports the agentId it would mint:

```bash
npm run agent:register -- --confirm
```

Set the printed `ERC8004_AGENT_ID` in the deployment env and redeploy, so
the agent card advertises the registration it now has. Re-run
`agent:verify` — the card and domain proof should stop saying "not
registered yet".

## Step 4 — submit the listings

- **BNB Agent Studio** — copy in [`listing/bnb-agent-studio.md`](../listing/bnb-agent-studio.md)
- **Yellow Crab** — copy in [`listing/yellowcrab.md`](../listing/yellowcrab.md)

Both are account-authenticated web submissions; nothing in this repo
submits them for you.

## Known gaps on the BNB path

Same spirit as the README's existing gaps list — these are real, not
hypothetical.

- **Field names confirmed against the spec, not against a live
  facilitator.** The 402 body, `X-PAYMENT` encoding, and `/verify`
  `/settle` shapes here follow the x402 v1 wire format that b402
  implements. `maxAmountRequired` is emitted alongside x402 v2's renamed
  `amount` so both generations of client read the same number. Run one
  real testnet payment (`B402_NETWORK=bsc-testnet`, with
  `B402_ASSET_ADDRESS` pointed at a faucet token) before mainnet: that is
  the only thing that proves the handshake end to end.
- **The orchestrator is not metered.** It chains services via internal
  calls that bypass the gate, so with payments on it refuses to run unless
  `ORCHESTRATOR_ALLOW_UNPAID=true`. It reports `amount_due` (the sum of
  what its sub-calls would have cost) but collects nothing. Metering it
  needs either a deferred-scheme authorization or per-sub-call settlement
  against the buyer's wallet.
- **`INTERNAL_SERVICE_TOKEN` is a real key.** Anyone holding it calls
  every priced service for free. It is only needed if you run the
  orchestrator at all; leave it unset otherwise.
- **`/api/admin/okx-balance` is still unauthenticated.** Pre-existing, but
  a public agent endpoint is a more exposed place for it than an OKX-only
  deployment was.

## How the two pricing problems were solved

Both were in the first version of this doc as things to fix before going
live. They are fixed; this is how, so the mechanisms aren't mistaken for
incidental complexity.

### Under-delivery is credited, not pocketed

x402's `exact` scheme settles one fixed amount, signed before the work
runs. Three services only learn their real quantity afterwards — S8 prices
per QC-passing asset, S10 per non-colliding token, S2 per second of video
Veo actually returned — and the gap always ran one way: the buyer paid for
what they requested and sometimes got less.

Refunding on-chain would need a hot wallet, gas, and transfers routinely
worth less than the gas to send them. Instead each route calls
`payment.reconcile(delivered, job_id)` before settling, and the shortfall
becomes a credit row (`supabase/migrations/0002_payment_credits.sql`)
applied against that wallet's next call:

```
request 10 assets  ->  charged 10 x 0.35 = 3.50
7 pass QC          ->  reconcile(7) credits 1.05
next call          ->  quoted 3.50, less 1.05 credit, 2.45 payable on-chain
```

Three ordering details that are load-bearing:

- Credit is **consumed at the gate**, not after the work. Consuming
  afterwards would let two concurrent calls each be quoted the same
  balance and both spend it.
- Consequently `withJob` **releases** reserved credit if the job fails —
  nothing was settled on-chain, so the credit must come back.
- A discount is only honoured if the **verified payer is the wallet that
  earned the credit**. Claiming someone else's wallet in `x-buyer-wallet`
  re-quotes at full price after `/verify` returns a different signer.

The arithmetic is a pure function, `shortfallCredit`, covered by
`tests/payments.test.ts` — including the case a naive implementation gets
wrong, where a job delivers *nothing* and `priceForRequest`'s quantity
floor of 1 would otherwise keep one unit's worth of the buyer's money.

### Prices are derived from costs, and checked

S2's flat $0.40/call against a Veo clip costing up to $1.20 survived
because nothing checked. Now:

- `lib/pricing/costs.ts` holds provider unit costs as data, with
  `PRICE_MARGIN` (default 60%) over worst-case cost.
- S2 is `per_second` at `VEO_PRICE_PER_SECOND`, so a 4s clip and an 8s clip
  are priced differently instead of averaging into a loss.
- **S1's video path was the bigger hole** — `output_type: "video"` runs the
  same Veo call behind S1's flat $0.05, a ~24x loss. It now bills at S2's
  per-second rate via `requirePayment`'s `priceAs`, while staying one
  service with one job type.
- `npm run verify:pricing` fails the build if any registry entry with a
  known cost stops covering it. It catches the exact original mistake: a
  hand-edited literal price below cost exits non-zero.

Run it in CI alongside `typecheck` and `lint`.

### Verifying the chain-side constants

`npm run verify:tokens` reads `symbol()` and `decimals()` off each
configured token contract and fails on any mismatch, then probes the
facilitator's `/supported` for our network and scheme. That replaces
trusting three hardcoded addresses and a decimals field — the field where
a value copied from an Ethereum config misprices everything by 10^12.

It needs network access, so it is not part of `npm test`; run it before
enabling payments and after any edit to `lib/chains/bnb.ts`.
