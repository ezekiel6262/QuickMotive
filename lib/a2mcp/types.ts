import type { ServiceType } from "@/lib/supabase/types";

export type PricingUnit = "per_call" | "per_delivered_asset" | "per_token" | "per_page";

export interface A2mcpPricing {
  unit: PricingUnit;
  amount: number;
  currency: "USDT" | "USDG";
  notes?: string;
}

/**
 * One entry per OKX.ai A2MCP tool listing. `route` is the internal API route
 * that implements the call; `inputSchema`/`outputSchema` are JSON Schema
 * fragments suitable for pasting into the OKX ASP tool registration form.
 */
export interface A2mcpToolDefinition {
  id: ServiceType;
  name: string;
  summary: string;
  route: string;
  pricing: A2mcpPricing;
  latencyExpectation: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}
