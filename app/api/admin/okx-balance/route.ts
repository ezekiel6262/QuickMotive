import { NextResponse } from "next/server";
import { getAccountBalance } from "@/lib/clients/okx";
import { handleRouteError } from "@/lib/api-helpers";

/**
 * Ops check: confirms the OKX account actually holds the configured
 * settlement currency (OKX_SETTLEMENT_CURRENCY, default USDT). Not an A2MCP
 * buyer-facing tool -- not listed in lib/a2mcp/registry.ts.
 *
 * SECURITY: unauthenticated. This exposes account balance figures to
 * anyone who can reach it. Add real access control (an admin token check,
 * IP allowlist, or move behind Vercel's deployment protection) before
 * relying on this outside of manual ops testing.
 */
export async function GET(req: Request) {
  try {
    const ccy = new URL(req.url).searchParams.get("ccy") ?? process.env.OKX_SETTLEMENT_CURRENCY ?? "USDT";
    const details = await getAccountBalance(ccy);
    return NextResponse.json({ ccy, details });
  } catch (err) {
    return handleRouteError(err);
  }
}
