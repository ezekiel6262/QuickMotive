# Yellow Crab — listing submission

Copy for the listing at <https://yellowcrab.xyz>.

Two things this environment could not establish, both worth confirming
before you submit:

- **The site could not be read from here** — yellowcrab.xyz is blocked by
  this session's network egress policy, and it does not appear in web
  search results for BNB agent marketplaces. So the submission mechanism
  (form, GitHub PR against a registry repo, on-chain listing, Telegram)
  and its required fields are unknown. Everything below is content, not a
  filled-in form: open the site, find the submit path, and map these
  across.
- **Whether it reads ERC-8004 directly.** Several BNB-ecosystem
  directories index the Identity Registry rather than taking manual
  submissions. If Yellow Crab does, completing step 3 of
  `docs/bnb-agent-deployment.md` may be the whole listing process, and the
  copy below is only needed for fields the card doesn't carry.

Everything a directory typically pulls automatically — name, description,
skills, schemas, prices, endpoints, payment terms — is already live in the
agent card at `https://<origin>/.well-known/agent-card.json`. Point the
listing at that first and only fill in by hand what it can't reach.

---

## Identity

| Field | Value |
|---|---|
| Name | QuickMotive |
| Category | Creative / NFT tooling |
| Chain | BNB Smart Chain (56) |
| Agent card | `https://<origin>/.well-known/agent-card.json` |
| MCP endpoint | `https://<origin>/api/mcp` |
| ERC-8004 | `eip155:56:<registry>` token `<agentId>` |
| Payments | b402 / x402 `exact`, USDT + USDC |
| Payout address | `<AGENT_PAYOUT_ADDRESS>` |
| Repository | https://github.com/ezekiel6262/quickmotive |

## One-liner

Eleven individually priced creative and NFT skills, callable by any agent
over MCP, paid per call in USDT on BNB Chain.

## Short description

QuickMotive is the creative desk other agents call. Image and video
generation, brand-locked batch production with QC, trait-based generative
art with hash dedup, on-chain NFT collection scanning with PDF rarity
reports, and marketplace-ready export bundles — eleven narrow skills, each
callable and priced on its own, from $0.05 to $3.00 a call.

No orchestration to adopt and no bundle to buy: an agent that needs one
capability buys one capability. Payment is x402 over b402, so a calling
agent pays in stablecoins with no gas and no account — and anything a call
doesn't deliver is credited back to the paying wallet automatically.

## Skills

`s1_prompt_bridge` · `s2_image_to_motion` · `s3_design_tweak` ·
`s4_nft_scanner_report` · `s5_brand_kit` · `s6_nft_image_gen` ·
`s7_nft_variation` · `s8_batch_generation` · `s9_export_bundle` ·
`s10_trait_engine` · `s11_game_template`

Full descriptions, JSON Schemas and prices are in the agent card; the
per-skill table is in [`bnb-agent-studio.md`](./bnb-agent-studio.md) if the
listing wants it inline.

## Tags

`ai-agent` `mcp` `erc-8004` `x402` `b402` `nft` `image-generation`
`video-generation` `generative-art` `onchain-data` `pdf-report`
`brand-consistency` `game`

## Verifying the listing before you submit

```bash
npm run agent:verify -- https://<origin>   # card, MCP, and a real 402
npm run verify:pricing                      # nothing sold below cost
npm run verify:tokens                       # token table matches the chain
npm test                                    # the money arithmetic
```

`agent:verify`'s five checks should all pass, with the 402 check reporting
a real `accepts` entry rather than "payment gate is off".
