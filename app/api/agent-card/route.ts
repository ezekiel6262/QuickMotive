import { NextResponse } from "next/server";
import { buildAgentCard } from "@/lib/agent/card";

/**
 * Served at `/.well-known/agent-card.json` via a rewrite in next.config.js.
 *
 * This is the document the ERC-8004 Identity Registry token's `tokenURI`
 * points at, and the one BNB Agent Studio / A2A clients fetch to discover
 * the skill catalog and its prices. Built fresh per request rather than
 * baked at build time so rotating `AGENT_PAYOUT_ADDRESS` or flipping
 * `X402_ENABLED` takes effect on redeploy of env alone.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return NextResponse.json(buildAgentCard(req), {
    headers: {
      // Indexers re-crawl; a short cache keeps a price edit from taking
      // hours to propagate while still absorbing bursts.
      "cache-control": "public, max-age=60, s-maxage=300",
      "access-control-allow-origin": "*"
    }
  });
}
