import { NextResponse } from "next/server";
import { A2MCP_TOOL_REGISTRY } from "@/lib/a2mcp/registry";

/**
 * Machine-readable catalog of every A2MCP tool this ASP exposes. Point the
 * OKX.ai OnchainOS "register tool schema" step at this endpoint, or copy the
 * per-tool JSON Schema fragments into the registration form by hand.
 */
export async function GET() {
  return NextResponse.json({ tools: A2MCP_TOOL_REGISTRY });
}
