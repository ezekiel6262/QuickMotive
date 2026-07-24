import { A2MCP_TOOL_REGISTRY } from "@/lib/a2mcp/registry";

export default function StatusPage() {
  return (
    <main className="page">
      <h1>QuickMotive</h1>
      <p>OKX.ai Creative &amp; NFT Agent Suite -- the creative + NFT-intelligence desk.</p>
      <p>
        Each service below is a standalone A2MCP tool with its own priced API route. See{" "}
        <code>/api/a2mcp/tools</code> for the machine-readable catalog used for OKX ASP
        registration.
      </p>

      <div className="grid">
        {A2MCP_TOOL_REGISTRY.map((tool) => (
          <article className="card" key={tool.id}>
            <h2>{tool.name}</h2>
            <code>{tool.route}</code>
            <div className="card-meta">
              <span>
                <strong>
                  {tool.pricing.amount} {tool.pricing.currency}
                </strong>{" "}
                / {tool.pricing.unit}
              </span>
              <span>{tool.latencyExpectation}</span>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
