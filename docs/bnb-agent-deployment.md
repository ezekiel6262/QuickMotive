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
| Pre-submission check | `scripts/verify-agent.ts` | Everything a marketplace reviewer or indexer will hit. |

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

Sanity-check the atomic amounts by hand before taking real money. BEP-20
USDT and USDC on BSC are **18-decimal**, unlike their 6-decimal
Ethereum/Base counterparts, so 0.10 USDT is `100000000000000000`. If you
see a number with six zeros where you expected eighteen, `decimals` in
`lib/chains/bnb.ts` is wrong and every price is off by 10^12.

Also re-verify the three token addresses in that file against BscScan.
They are the well-known BSC deployments, but this is the one file where a
copy error sends buyer funds to the wrong contract.

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
- **Variable-count pricing is charged up front.** x402 `exact` needs a
  fixed amount before the work runs, but S8 prices per *passing* asset and
  S10 per *non-colliding* token — neither is known until afterwards. Both
  currently charge for the requested count, which overcharges whenever QC
  flags an asset or dedup rejects a token. Either refund the difference
  out of band, move those two to x402's deferred scheme, or restate their
  listing copy as "priced per requested item". Until one of those, the
  listing copy in `listing/` describes them as priced per requested item,
  which is what the code does.
- **The orchestrator is not metered.** It chains services via internal
  calls that bypass the gate, so with payments on it refuses to run unless
  `ORCHESTRATOR_ALLOW_UNPAID=true`. It reports `amount_due` (the sum of
  what its sub-calls would have cost) but collects nothing. Metering it
  needs either a deferred-scheme authorization or per-sub-call settlement
  against the buyer's wallet.
- **`INTERNAL_SERVICE_TOKEN` is a real key.** Anyone holding it calls
  every priced service for free. It is only needed if you run the
  orchestrator at all; leave it unset otherwise.
- **S2's price still doesn't cover Veo.** Unchanged from the README's
  existing risk list, and it matters more here: on BNB the price is
  enforced on-chain rather than invoiced, so a $0.40 call that costs
  ~$0.75–1.20 in Veo time loses money on every request. Fix the price in
  `lib/a2mcp/registry.ts` before enabling payments, and the agent card and
  both listings follow automatically.
- **`/api/admin/okx-balance` is still unauthenticated.** Pre-existing, but
  a public agent endpoint is a more exposed place for it than an OKX-only
  deployment was.
