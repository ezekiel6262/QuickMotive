import { NextResponse } from "next/server";
import { buildAgentRegistrationProof } from "@/lib/agent/card";

/**
 * Served at `/.well-known/agent-registration.json` via next.config.js.
 *
 * ERC-8004's optional domain-control proof: an indexer that finds an onchain
 * registration claiming this hostname can fetch this file and confirm the
 * hostname claims the same registration back. Empty `registrations` until
 * `npm run agent:register` has minted and `ERC8004_AGENT_ID` is set --
 * which is itself the honest answer at that point, not a failure.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return NextResponse.json(buildAgentRegistrationProof(req), {
    headers: { "cache-control": "public, max-age=60, s-maxage=300", "access-control-allow-origin": "*" }
  });
}
