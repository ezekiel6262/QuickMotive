import { NextResponse } from "next/server";
import { A2MCP_TOOL_REGISTRY, getToolDefinition } from "@/lib/a2mcp/registry";
import { AGENT_DESCRIPTION, AGENT_NAME, agentBaseUrl } from "@/lib/agent/card";

/**
 * MCP endpoint (JSON-RPC 2.0 over HTTP) exposing all eleven services as
 * MCP tools.
 *
 * Why this exists alongside `/api/a2mcp/tools`: that route is a *catalog*
 * for OKX's ASP registration form -- it describes the services but cannot
 * invoke them. BNB Agent Studio and every generic MCP client want one
 * callable endpoint they can point at and immediately use, which is this.
 *
 * Invocation is a proxy to the same route handlers a direct HTTP buyer
 * hits, with `X-PAYMENT` forwarded untouched, so there is exactly one
 * implementation and one payment gate per service. A 402 from downstream
 * comes back as an MCP error whose `data` carries the x402 `accepts` list,
 * which is how an x402-aware MCP client learns what to sign.
 *
 * Scope: request/response JSON only -- no SSE, no sessions, no
 * server-initiated messages. `capabilities` below says so honestly rather
 * than advertising features a client would then fail to use.
 */

const MCP_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result: value });
}

function error(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });
}

function mcpTools() {
  return A2MCP_TOOL_REGISTRY.map((tool) => ({
    name: tool.id,
    title: tool.name,
    description:
      `${tool.summary}\n\n` +
      `Price: ${tool.pricing.amount} ${tool.pricing.currency} ${tool.pricing.unit.replace(/_/g, " ")}` +
      `${tool.pricing.notes ? ` (${tool.pricing.notes})` : ""}. ` +
      `Typical latency: ${tool.latencyExpectation}.`,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    _meta: {
      "x402/pricing": tool.pricing,
      "quickmotive/route": tool.route
    }
  }));
}

async function callTool(req: Request, name: string, args: Record<string, unknown>) {
  const tool = getToolDefinition(name as never);
  if (!tool) return { notFound: true as const };

  const headers: Record<string, string> = { "content-type": "application/json" };
  // Forward the payment authorization and buyer identity verbatim -- the
  // service route owns verification, this proxy must not reinterpret them.
  for (const h of ["x-payment", "x-buyer-wallet"]) {
    const value = req.headers.get(h);
    if (value) headers[h] = value;
  }

  const res = await fetch(`${agentBaseUrl(req)}${tool.route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args)
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: text.slice(0, 1000) };
  }

  return {
    notFound: false as const,
    status: res.status,
    body: parsed,
    paymentResponse: res.headers.get("x-payment-response")
  };
}

export async function POST(req: Request) {
  let rpc: JsonRpcRequest;
  try {
    rpc = (await req.json()) as JsonRpcRequest;
  } catch {
    return error(null, -32700, "Parse error: body is not valid JSON");
  }

  switch (rpc.method) {
    case "initialize":
      return result(rpc.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: AGENT_NAME, version: process.env.AGENT_VERSION ?? "1.0.0" },
        instructions: AGENT_DESCRIPTION
      });

    case "notifications/initialized":
      // Notification: no id, no response body expected.
      return new NextResponse(null, { status: 202 });

    case "ping":
      return result(rpc.id, {});

    case "tools/list":
      return result(rpc.id, { tools: mcpTools() });

    case "tools/call": {
      const name = String(rpc.params?.name ?? "");
      const args = (rpc.params?.arguments as Record<string, unknown>) ?? {};
      const call = await callTool(req, name, args);

      if (call.notFound) {
        return error(rpc.id, -32602, `Unknown tool "${name}"`, { available: A2MCP_TOOL_REGISTRY.map((t) => t.id) });
      }

      if (call.status === 402) {
        // Surfaced as a JSON-RPC error so an unaware client fails loudly
        // rather than treating the accepts list as a deliverable, with the
        // full x402 body in `data` for a client that does understand it.
        return error(rpc.id, -32003, "Payment required", { x402: call.body });
      }

      if (call.status >= 400) {
        return error(rpc.id, -32000, `Tool "${name}" failed (HTTP ${call.status})`, call.body);
      }

      return result(rpc.id, {
        content: [{ type: "text", text: JSON.stringify(call.body, null, 2) }],
        structuredContent: call.body,
        isError: false,
        ...(call.paymentResponse ? { _meta: { "x402/payment-response": call.paymentResponse } } : {})
      });
    }

    default:
      return error(rpc.id, -32601, `Method "${rpc.method}" not supported`, {
        supported: ["initialize", "ping", "tools/list", "tools/call"]
      });
  }
}

/** Discovery convenience: GET returns the tool list without a JSON-RPC envelope. */
export async function GET() {
  return NextResponse.json({
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: { name: AGENT_NAME, version: process.env.AGENT_VERSION ?? "1.0.0" },
    tools: mcpTools()
  });
}
