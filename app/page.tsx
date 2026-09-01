import { A2MCP_TOOL_REGISTRY } from "@/lib/a2mcp/registry";
import { getChainConfig } from "@/lib/chains/bnb";
import { headers } from "next/headers";

/**
 * The page a buyer -- or a marketplace reviewer assessing a listing --
 * lands on. It has one job: make it obvious what this agent does, what it
 * costs, and how to hire it, without anyone reading the repo.
 *
 * Deliberately server-rendered from the same registry the agent card and
 * MCP endpoint use, so a price can never be right in one place and stale
 * in another.
 */

export const dynamic = "force-dynamic";

function priceLabel(pricing: (typeof A2MCP_TOOL_REGISTRY)[number]["pricing"]): string {
  const unit = pricing.unit.replace(/_/g, " ").replace(/^per /, "");
  return `${pricing.amount} ${pricing.currency} / ${unit}`;
}

function originFrom(host: string | null, forwardedProto: string | null): string {
  if (process.env.AGENT_BASE_URL) return process.env.AGENT_BASE_URL.replace(/\/$/, "");
  if (!host) return "https://quickmotive.example";
  // Vercel sets x-forwarded-proto; fall back to the scheme a local host
  // actually serves, so the copy-paste endpoints below are never wrong.
  const proto = forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

export default function StatusPage() {
  const requestHeaders = headers();
  const origin = originFrom(requestHeaders.get("host"), requestHeaders.get("x-forwarded-proto"));
  const chain = getChainConfig();
  const registered = process.env.ERC8004_AGENT_ID && process.env.ERC8004_IDENTITY_REGISTRY;
  const paymentsOn = process.env.X402_ENABLED === "true";

  // S2's three allowed durations are the only variable-priced thing on the
  // page; showing them as three numbers avoids "0.24/second" reading as an
  // open-ended meter.
  const videoRate = A2MCP_TOOL_REGISTRY.find((t) => t.id === "s2_image_to_motion")?.pricing.amount ?? 0;

  return (
    <main className="page">
      <h1>QuickMotive</h1>
      <p className="lede">
        The creative and NFT-intelligence desk for autonomous agents. Eleven narrow skills, each
        callable and priced on its own, over MCP on {chain.name}.
      </p>

      <div className="status-row">
        <span className={paymentsOn ? "pill pill-live" : "pill"}>
          {paymentsOn ? `Accepting payment on ${chain.name}` : "Free preview — payments not enabled"}
        </span>
        <span className="pill">
          {registered
            ? `ERC-8004 #${process.env.ERC8004_AGENT_ID}`
            : "ERC-8004 registration pending"}
        </span>
      </div>

      <h2 className="section">Hire this agent</h2>
      <ol className="steps">
        <li>
          Point any MCP client at <code>{origin}/api/mcp</code> and call <code>tools/list</code>.
          Every skill, its JSON Schema and its price come back in one response.
        </li>
        <li>
          Call a skill with <code>tools/call</code>. Unpaid calls answer{" "}
          <strong>HTTP 402</strong> with the price in USDT or USDC and the contract to pay.
        </li>
        <li>
          Sign the payment authorization, retry with an <code>X-PAYMENT</code> header, and the work
          runs. Settlement goes through the b402 relayer, so you spend no gas.
        </li>
      </ol>
      <p className="note">
        Nothing is charged until the payment verifies, and settlement only runs after the work
        succeeds — a failed job takes no money. Anything a call doesn&apos;t deliver is credited
        back to the paying wallet and applied to its next call.
      </p>

      <h2 className="section">Machine endpoints</h2>
      <div className="endpoints">
        <div>
          <strong>Agent card</strong>
          <code>{origin}/.well-known/agent-card.json</code>
          <span>A2A AgentCard and ERC-8004 registration file, in one document.</span>
        </div>
        <div>
          <strong>MCP</strong>
          <code>{origin}/api/mcp</code>
          <span>JSON-RPC: initialize, tools/list, tools/call.</span>
        </div>
        <div>
          <strong>Catalog</strong>
          <code>{origin}/api/a2mcp/tools</code>
          <span>Raw skill catalog with input/output schemas.</span>
        </div>
      </div>

      <h2 className="section">Payment</h2>
      <div className="endpoints">
        <div>
          <strong>Network</strong>
          <code>{chain.name} — chainId {chain.chainId}</code>
          <span>CAIP-2 {chain.caip2}</span>
        </div>
        <div>
          <strong>Protocol</strong>
          <code>b402 (x402 &ldquo;exact&rdquo;)</code>
          <span>USDT or USDC. Gasless for the payer via the b402 relayer.</span>
        </div>
        <div>
          <strong>Video pricing</strong>
          <code>
            4s {(videoRate * 4).toFixed(2)} · 6s {(videoRate * 6).toFixed(2)} · 8s{" "}
            {(videoRate * 8).toFixed(2)}
          </code>
          <span>The only three durations Veo accepts; every other skill is one flat price.</span>
        </div>
      </div>

      <h2 className="section">Skills</h2>
      <div className="grid">
        {A2MCP_TOOL_REGISTRY.map((tool) => (
          <article className="card" key={tool.id}>
            <h3>{tool.name}</h3>
            <p className="card-summary">{tool.summary}</p>
            <code>{tool.id}</code>
            <div className="card-meta">
              <span>
                <strong>{priceLabel(tool.pricing)}</strong>
              </span>
              <span>{tool.latencyExpectation}</span>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
