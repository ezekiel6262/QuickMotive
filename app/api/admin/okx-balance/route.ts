import { NextResponse } from "next/server";
import { getAccountBalance } from "@/lib/clients/okx";
import { handleRouteError, ApiError } from "@/lib/api-helpers";
import { checkAdminAuth } from "@/lib/admin-auth";

/**
 * Ops check: confirms the OKX account actually holds the configured
 * settlement currency (OKX_SETTLEMENT_CURRENCY, default USDT). Not a
 * buyer-facing tool -- deliberately absent from lib/a2mcp/registry.ts.
 *
 * This route used to be unauthenticated, on the stated assumption that
 * Vercel's deployment protection stood in front of it. That assumption
 * expires the moment this app is reachable by buyer agents: an agent
 * marketplace listing is worthless if the URL demands an SSO login, so
 * going live means the protection comes off -- and this endpoint returns
 * real account balances.
 *
 * So it carries its own auth now, and fails closed:
 *
 *  - `ADMIN_API_TOKEN` unset -> 404. An ops endpoint nobody configured
 *    should not exist, and 404 rather than 401 keeps it from advertising
 *    itself to a scanner.
 *  - token set -> `Authorization: Bearer <token>` required, compared in
 *    constant time so a wrong guess leaks nothing through timing.
 */

function assertAuthorized(req: Request): void {
  const result = checkAdminAuth(req.headers.get("authorization"), process.env.ADMIN_API_TOKEN);
  if (!result.ok) throw new ApiError(result.status, result.message);
}

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const ccy = new URL(req.url).searchParams.get("ccy") ?? process.env.OKX_SETTLEMENT_CURRENCY ?? "USDT";
    const details = await getAccountBalance(ccy);
    return NextResponse.json({ ccy, details });
  } catch (err) {
    return handleRouteError(err);
  }
}
