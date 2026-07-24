import type { CSSProperties } from "react";
import { A2MCP_TOOL_REGISTRY } from "@/lib/a2mcp/registry";

export default function StatusPage() {
  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "48px 24px" }}>
      <h1>QuickMotive</h1>
      <p>OKX.ai Creative &amp; NFT Agent Suite -- the creative + NFT-intelligence desk.</p>
      <p>
        Each service below is a standalone A2MCP tool with its own priced API route. See{" "}
        <code>/api/a2mcp/tools</code> for the machine-readable catalog used for OKX ASP registration.
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Service</th>
            <th style={cellStyle}>Route</th>
            <th style={cellStyle}>Price</th>
            <th style={cellStyle}>Latency</th>
          </tr>
        </thead>
        <tbody>
          {A2MCP_TOOL_REGISTRY.map((tool) => (
            <tr key={tool.id}>
              <td style={cellStyle}>{tool.name}</td>
              <td style={cellStyle}>
                <code>{tool.route}</code>
              </td>
              <td style={cellStyle}>
                {tool.pricing.amount} {tool.pricing.currency} / {tool.pricing.unit}
              </td>
              <td style={cellStyle}>{tool.latencyExpectation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

const cellStyle: CSSProperties = {
  border: "1px solid #ddd",
  padding: "8px 12px",
  textAlign: "left",
  fontSize: 14
};
