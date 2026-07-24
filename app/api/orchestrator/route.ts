import { NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { getAnthropicClient, ORCHESTRATOR_MODEL } from "@/lib/clients/anthropic";
import { A2MCP_TOOL_REGISTRY } from "@/lib/a2mcp/registry";
import { withJob } from "@/lib/jobs";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  request: z.string().min(1),
  max_tool_calls: z.number().int().min(1).max(10).default(5)
});

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
  const res = await fetch(`${baseUrl}${tool.route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-buyer-wallet": buyerWallet },
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
 */
export async function POST(req: Request) {
  try {
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
            return { final_message: text, tool_calls: toolCalls };
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

        return { final_message: "Reached max_tool_calls without a final answer.", tool_calls: toolCalls };
      }
    );

    return NextResponse.json({ job_id, ...output });
  } catch (err) {
    return handleRouteError(err);
  }
}
