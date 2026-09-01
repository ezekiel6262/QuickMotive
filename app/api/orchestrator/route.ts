import { NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { parseBody, requireBuyerWallet, handleRouteError, ApiError } from "@/lib/api-helpers";
import { isPaymentEnabled } from "@/lib/payments/x402";
import { getAnthropicClient, ORCHESTRATOR_MODEL } from "@/lib/clients/anthropic";
import { A2MCP_TOOL_REGISTRY } from "@/lib/a2mcp/registry";
import { withJob } from "@/lib/jobs";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  request: z.string().min(1),
  max_tool_calls: z.number().int().min(1).max(10).default(5)
});

/**
 * What the chained sub-calls would have cost if each had been paid for
 * directly. Each service route echoes its own quoted price back in
 * `payment.amount`, so this is the sum the buyer actually owes -- reported,
 * not collected, until the orchestrator is properly metered.
 */
function sumAmountDue(toolCalls: Array<{ result: unknown }>): { amount: number; currency: string } | null {
  let total = 0;
  let currency: string | null = null;
  for (const call of toolCalls) {
    const payment = (call.result as { payment?: { amount?: unknown; currency?: unknown } } | null)?.payment;
    if (typeof payment?.amount === "number") {
      total += payment.amount;
      if (typeof payment.currency === "string") currency = currency ?? payment.currency;
    }
  }
  if (currency === null) return null;
  return { amount: Number(total.toFixed(6)), currency };
}

function toolsForClaude(baseUrl: string): Anthropic.Tool[] {
  return A2MCP_TOOL_REGISTRY.map((tool) => ({
    name: tool.id,
    description: `${tool.summary} (price: ${tool.pricing.amount} ${tool.pricing.currency} ${tool.pricing.unit})`,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
  }));
}

async function invokeService(baseUrl: string, serviceId: string, input: Record<string, unknown>, buyerWallet: string) {
  const tool = getToolDefinition(serviceId);
  if (!tool) throw new Error(`Unknown service ${serviceId}`);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-buyer-wallet": buyerWallet
  };
  // With the x402 gate on, these sub-calls would 402 against our own
  // routes. The internal token bypasses the gate; the sub-call still
  // records a priced job row, so what the buyer owes stays auditable.
  if (process.env.INTERNAL_SERVICE_TOKEN) {
    headers["x-internal-service-token"] = process.env.INTERNAL_SERVICE_TOKEN;
  }

  const res = await fetch(`${baseUrl}${tool.route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `${serviceId} failed with ${res.status}`);
  return json;
}

/**
 * "Do it all" convenience entry point. Every service works standalone
 * without this -- this route exists so a buyer can describe a goal in
 * natural language and let Claude pick and chain the underlying A2MCP
 * tools, each of which is billed independently by its own route.
 *
 * Not x402-priced, and deliberately so: it has no registry entry (adding
 * one would also make it list itself as a callable tool), and a single
 * "exact" payment authorization cannot cover a chain whose cost is only
 * known after Claude decides what to call. Since it bypasses the payment
 * gate on every sub-call, leaving it open while the gate is on would hand
 * out the whole suite for free -- hence the refusal below. Metering it
 * properly (deferred-scheme x402, or settle-per-sub-call with the buyer's
 * wallet) is tracked in the README's "Known integration gaps".
 */
export async function POST(req: Request) {
  try {
    if (isPaymentEnabled() && process.env.ORCHESTRATOR_ALLOW_UNPAID !== "true") {
      throw new ApiError(
        503,
        "Orchestrator is disabled while x402 payments are enabled: it is not metered, and it " +
          "bypasses the payment gate on the services it chains. Call the individual services " +
          "directly, or set ORCHESTRATOR_ALLOW_UNPAID=true to accept serving it for free."
      );
    }

    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet);
    const baseUrl = new URL(req.url).origin;

    const { job_id, output } = await withJob(
      { serviceType: "orchestrator", buyerWallet, input: body },
      async () => {
        const client = getAnthropicClient();
        const tools = toolsForClaude(baseUrl);
        const toolCalls: Array<{ tool: string; input: unknown; result: unknown }> = [];

        const messages: Anthropic.MessageParam[] = [{ role: "user", content: body.request }];

        for (let round = 0; round < body.max_tool_calls; round++) {
          const response = await client.messages.create({
            model: ORCHESTRATOR_MODEL,
            max_tokens: 2048,
            tools,
            messages
          });

          const toolUseBlocks = response.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
          );

          if (toolUseBlocks.length === 0) {
            const text = response.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("\n");
            return { final_message: text, tool_calls: toolCalls, amount_due: sumAmountDue(toolCalls) };
          }

          messages.push({ role: "assistant", content: response.content });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of toolUseBlocks) {
            try {
              const result = await invokeService(baseUrl, block.name, block.input as Record<string, unknown>, buyerWallet);
              toolCalls.push({ tool: block.name, input: block.input, result });
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: message, is_error: true });
            }
          }
          messages.push({ role: "user", content: toolResults });
        }

        return {
          final_message: "Reached max_tool_calls without a final answer.",
          tool_calls: toolCalls,
          amount_due: sumAmountDue(toolCalls)
        };
      }
    );

    return NextResponse.json({ job_id, ...output });
  } catch (err) {
    return handleRouteError(err);
  }
}
