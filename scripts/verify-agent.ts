/**
 * Pre-submission smoke test for the BNB Agent Studio / Yellow Crab listings.
 *
 *   npm run agent:verify -- https://your-deployment.example
 *
 * Checks the things a marketplace reviewer (or an ERC-8004 indexer) will
 * check, in the order they'd hit them, and exits non-zero if any fail. Run
 * it against the real deployment before submitting either listing --
 * every one of these is a rejection reason.
 */

const base = (process.argv[2] ?? process.env.AGENT_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

interface Check {
  name: string;
  run: () => Promise<string>;
}

const checks: Check[] = [
  {
    name: "agent card resolves at /.well-known/agent-card.json",
    run: async () => {
      const res = await fetch(`${base}/.well-known/agent-card.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const card = (await res.json()) as {
        name?: string;
        skills?: unknown[];
        registrations?: unknown[];
        payments?: { payTo?: string; enabled?: boolean };
      };
      if (!card.name) throw new Error("card has no `name`");
      if (!Array.isArray(card.skills) || card.skills.length === 0) throw new Error("card lists no skills");
      const notes: string[] = [`${card.name}, ${card.skills.length} skills`];
      if (!card.registrations?.length) notes.push("no on-chain registration yet (run agent:register)");
      if (!card.payments?.payTo) notes.push("AGENT_PAYOUT_ADDRESS unset");
      if (!card.payments?.enabled) notes.push("X402_ENABLED is not true");
      return notes.join("; ");
    }
  },
  {
    name: "domain proof resolves at /.well-known/agent-registration.json",
    run: async () => {
      const res = await fetch(`${base}/.well-known/agent-registration.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const proof = (await res.json()) as { registrations?: unknown[] };
      return proof.registrations?.length ? `${proof.registrations.length} registration(s)` : "empty (not registered yet)";
    }
  },
  {
    name: "MCP endpoint answers initialize",
    run: async () => {
      const res = await fetch(`${base}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      });
      const json = (await res.json()) as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } };
      if (!json.result?.protocolVersion) throw new Error(`no protocolVersion in ${JSON.stringify(json).slice(0, 200)}`);
      return `${json.result.serverInfo?.name} @ MCP ${json.result.protocolVersion}`;
    }
  },
  {
    name: "MCP tools/list returns the full catalog",
    run: async () => {
      const res = await fetch(`${base}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      });
      const json = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
      const tools = json.result?.tools ?? [];
      if (tools.length !== 11) throw new Error(`expected 11 tools, got ${tools.length}`);
      return tools.map((t) => t.name).join(", ");
    }
  },
  {
    name: "priced route answers 402 with a usable accepts list",
    run: async () => {
      const res = await fetch(`${base}/api/services/s5-brand-kit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "verify-probe", buyer_wallet: "0x0000000000000000000000000000000000000000" })
      });

      if (res.status !== 402) {
        // Not a failure on its own: with X402_ENABLED unset the gate is a
        // no-op by design. Say which case this is rather than passing
        // silently, since "no 402" is a listing blocker if payments were
        // meant to be on.
        return `no 402 (HTTP ${res.status}) -- payment gate is off; set X402_ENABLED=true to charge`;
      }

      const body = (await res.json()) as { accepts?: Array<Record<string, unknown>> };
      const accept = body.accepts?.[0];
      if (!accept) throw new Error("402 returned no `accepts` entries");
      for (const field of ["scheme", "network", "maxAmountRequired", "payTo", "asset"]) {
        if (!accept[field]) throw new Error(`accepts[0] missing ${field}`);
      }
      return `${accept.scheme} on ${accept.network}, ${accept.maxAmountRequired} of ${accept.asset}`;
    }
  }
];

async function main() {
  console.log(`verifying ${base}\n`);
  let failed = 0;

  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`  PASS  ${check.name}\n        ${detail}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${check.name}\n        ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
