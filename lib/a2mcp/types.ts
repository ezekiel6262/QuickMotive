import type { ServiceType } from "@/lib/supabase/types";

export type PricingUnit =
  | "per_call"
  | "per_delivered_asset"
  | "per_token"
  | "per_page"
  /**
   * Priced by seconds of generated output. Added for S2/S1-video, whose
   * provider cost is per-second -- a flat per-call price on those either
   * overcharges a 4s clip or loses money on an 8s one.
   */
  | "per_second";

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
  /**
   * Worst-case provider cost for one priced unit, when it is known. Present
   * only where `lib/pricing/costs.ts` has a sourced figure;
   * `npm run verify:pricing` asserts `pricing.amount` covers it, so a
   * loss-making price fails a check instead of settling on-chain.
   */
  costBasis?: { unitCost: number; provider: string };
  latencyExpectation: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}
