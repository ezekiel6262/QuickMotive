import { A2MCP_TOOL_REGISTRY } from "@/lib/a2mcp/registry";
import {
  getChainConfig,
  getSettlementToken,
  resolveNetwork,
  toAtomicUnits
} from "@/lib/chains/bnb";

/**
 * The agent card: one JSON document that is simultaneously
 *
 *  - an A2A AgentCard, which is what agent-to-agent clients (BNB Agent
 *    Studio's included) read to discover what this agent can do, and
 *  - an ERC-8004 registration file, which is what the Identity Registry
 *    ERC-721's `tokenURI` resolves to onchain.
 *
 * ERC-8004's registration file is deliberately specified as a superset of
 * the A2A AgentCard, so one document serves both and there is no second
 * catalog to keep in sync. Every skill here is derived from
 * `lib/a2mcp/registry.ts` -- the same source the OKX A2MCP listing uses --
 * so a price or schema change propagates to both marketplaces from one edit.
 *
 * Served at `/.well-known/agent-card.json` (rewritten in next.config.js),
 * which is the conventional location ERC-8004 indexers probe.
 */

const A2A_PROTOCOL_VERSION = "0.3.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const ERC8004_REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

export const AGENT_NAME = "QuickMotive";
export const AGENT_DESCRIPTION =
  "Creative and NFT-intelligence desk for autonomous agents. Eleven individually " +
  "callable, individually priced skills: image and video generation, prompt " +
  "extraction, brand-locked batch production, trait-based generative art with " +
  "hash dedup, on-chain NFT collection scanning with PDF reports, marketplace-" +
  "ready export bundles, and playable game templates skinned with a character.";

export function agentBaseUrl(req?: Request): string {
  const configured = process.env.AGENT_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (req) return new URL(req.url).origin;
  return "http://localhost:3000";
}

/**
 * ERC-8004 identifies a registration as `{namespace}:{chainId}:{registry}`
 * plus the ERC-721 tokenId. Both halves come from env because they only
 * exist after `npm run agent:register` has actually minted.
 */
function registrations() {
  const chain = getChainConfig();
  const registry = process.env.ERC8004_IDENTITY_REGISTRY;
  const agentId = process.env.ERC8004_AGENT_ID;
  if (!registry || !agentId) return [];
  return [
    {
      agentId: Number(agentId),
      agentRegistry: `${chain.caip2}:${registry}`,
      agentAddress: process.env.AGENT_WALLET_ADDRESS ?? undefined
    }
  ];
}

/**
 * Per-skill payment terms in the shape an x402/b402 client can act on
 * without a round trip: it can read the price here, or hit the endpoint
 * and read the same numbers back off the 402.
 */
function paymentsFor(pricing: { unit: string; amount: number; currency: string }) {
  const network = resolveNetwork();
  const chain = getChainConfig(network);
  const currencies = (process.env.B402_ACCEPTED_CURRENCIES ?? "USDT,USDC")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  return currencies
    .map((symbol) => {
      let token;
      try {
        token = getSettlementToken(symbol, network);
      } catch {
        return null; // symbol not configured for this network -- skip it
      }
      return {
        protocol: "b402",
        x402Version: 1,
        scheme: "exact",
        network,
        chainId: chain.chainId,
        asset: token.address,
        assetSymbol: token.symbol,
        decimals: token.decimals,
        amount: toAtomicUnits(pricing.amount, token.decimals),
        humanAmount: pricing.amount,
        unit: pricing.unit,
        payTo: process.env.AGENT_PAYOUT_ADDRESS ?? undefined
      };
    })
    .filter(Boolean);
}

export function buildAgentCard(req?: Request) {
  const base = agentBaseUrl(req);
  const chain = getChainConfig();

  const skills = A2MCP_TOOL_REGISTRY.map((tool) => ({
    id: tool.id,
    name: tool.name,
    description: tool.summary,
    tags: skillTags(tool.id),
    inputModes: ["application/json"],
    outputModes: ["application/json"],
    // Extensions beyond the A2A skill shape: everything a buyer needs to
    // call and price the skill directly over HTTP, not just via A2A.
    endpoint: `${base}${tool.route}`,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    pricing: {
      unit: tool.pricing.unit,
      amount: tool.pricing.amount,
      currency: tool.pricing.currency,
      notes: tool.pricing.notes
    },
    latency: tool.latencyExpectation,
    payments: paymentsFor(tool.pricing)
  }));

  return {
    // ---- ERC-8004 registration file ----
    type: ERC8004_REGISTRATION_TYPE,
    registrations: registrations(),
    /**
     * No validator or TEE attestation is wired up, so claiming anything
     * beyond client feedback would be a false trust signal.
     */
    supportedTrust: ["reputation"],
    endpoints: [
      { name: "MCP", endpoint: `${base}/api/mcp`, version: MCP_PROTOCOL_VERSION },
      { name: "catalog", endpoint: `${base}/api/a2mcp/tools`, version: "1.0" }
    ],

    // ---- A2A AgentCard ----
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    url: `${base}/api/mcp`,
    preferredTransport: "JSONRPC",
    version: process.env.AGENT_VERSION ?? "1.0.0",
    documentationUrl: `${base}/`,
    provider: {
      organization: process.env.AGENT_PROVIDER_NAME ?? "QuickMotive",
      url: process.env.AGENT_PROVIDER_URL ?? base
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills,

    // ---- Payment terms (x402/b402) ----
    payments: {
      protocol: "b402",
      x402Version: 1,
      network: chain.network,
      chainId: chain.chainId,
      caip2: chain.caip2,
      facilitator: process.env.B402_FACILITATOR_URL ?? "https://facilitator.b402.ai",
      relayer: chain.relayerContract,
      payTo: process.env.AGENT_PAYOUT_ADDRESS ?? undefined,
      enabled: process.env.X402_ENABLED === "true",
      /** Priced per skill; see `skills[].payments`. */
      perSkillPricing: true
    }
  };
}

/**
 * ERC-8004 indexers and marketplace search both key off tags, so these are
 * discovery surface, not decoration. Kept next to the card rather than in
 * the A2MCP registry because they exist for this listing, not for OKX.
 */
function skillTags(id: string): string[] {
  const common = ["creative", "nft"];
  const perSkill: Record<string, string[]> = {
    s1_prompt_bridge: ["prompt-engineering", "image", "video", "captioning"],
    s2_image_to_motion: ["video", "animation", "image-to-video"],
    s3_design_tweak: ["graphic-design", "editing", "canva"],
    s4_nft_scanner_report: ["onchain-data", "analytics", "rarity", "pdf-report"],
    s5_brand_kit: ["branding", "style-guide", "consistency"],
    s6_nft_image_gen: ["image-generation", "collection"],
    s7_nft_variation: ["image-generation", "img2img", "variation"],
    s8_batch_generation: ["batch", "quality-control", "image-generation"],
    s9_export_bundle: ["export", "metadata", "marketplace-ready"],
    s10_trait_engine: ["generative-art", "traits", "dedup", "collection"],
    s11_game_template: ["game", "html5", "playable"]
  };
  return [...common, ...(perSkill[id] ?? [])];
}

/**
 * ERC-8004's optional domain-control proof: the registry can check that
 * whoever controls this hostname also claims these registrations.
 */
export function buildAgentRegistrationProof(req?: Request) {
  return {
    type: ERC8004_REGISTRATION_TYPE,
    name: AGENT_NAME,
    registrations: registrations(),
    agentCard: `${agentBaseUrl(req)}/.well-known/agent-card.json`
  };
}
