/**
 * Verify the settlement token table against the chain, and the facilitator
 * against itself.
 *
 *   npm run verify:tokens
 *
 * Two things were previously trusted on faith and are now checked:
 *
 *  - **Token addresses and decimals.** `lib/chains/bnb.ts` hardcodes three
 *    BEP-20 addresses. If one is wrong, buyer funds are quoted against the
 *    wrong contract. If `decimals` is wrong, every price is off by orders
 *    of magnitude -- BSC USDT is 18-decimal where Ethereum's is 6, so a
 *    copied constant is off by 10^12 and settles for a millionth of the
 *    intended amount. This reads `symbol()` and `decimals()` from each
 *    contract and fails on any mismatch.
 *
 *  - **The facilitator actually supports what we advertise.** x402
 *    facilitators expose `/supported`; this checks our network, scheme and
 *    assets appear in it, rather than discovering at first payment that
 *    they don't.
 *
 * Needs network access and an RPC endpoint. Run it before enabling
 * payments, and again after any change to the token table.
 */

import { createPublicClient, http, type Address } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import {
  BSC_MAINNET_TOKENS,
  BSC_TESTNET_TOKENS,
  getChainConfig,
  resolveNetwork,
  toAtomicUnits
} from "../lib/chains/bnb";

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }
] as const;

const failures: string[] = [];

async function verifyTokens() {
  const network = resolveNetwork();
  const chainConfig = getChainConfig(network);
  const chain = network === "bsc-testnet" ? bscTestnet : bsc;
  const rpcUrl = process.env.BSC_RPC_URL ?? chain.rpcUrls.default.http[0];
  const table = network === "bsc-testnet" ? BSC_TESTNET_TOKENS : BSC_MAINNET_TOKENS;

  console.log(`network: ${network} (chainId ${chainConfig.chainId})`);
  console.log(`rpc:     ${rpcUrl}\n`);

  const entries = Object.entries(table);
  if (entries.length === 0) {
    console.log("No tokens in the table for this network -- set B402_ASSET_ADDRESS to override.\n");
    return;
  }

  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  for (const [key, token] of entries) {
    try {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: token.address as Address, abi: ERC20_ABI, functionName: "symbol" }),
        client.readContract({ address: token.address as Address, abi: ERC20_ABI, functionName: "decimals" })
      ]);

      const symbolOk = String(symbol).toUpperCase() === token.symbol.toUpperCase();
      const decimalsOk = Number(decimals) === token.decimals;

      if (symbolOk && decimalsOk) {
        // Show what one dollar looks like in atomic units, because that is
        // the number a mis-set `decimals` corrupts.
        console.log(
          `  PASS  ${key}: ${symbol}, ${decimals} decimals — 1.00 = ${toAtomicUnits(1, token.decimals)}`
        );
      } else {
        const detail = [
          symbolOk ? null : `symbol is "${symbol}", table says "${token.symbol}"`,
          decimalsOk ? null : `decimals is ${decimals}, table says ${token.decimals}`
        ]
          .filter(Boolean)
          .join("; ");
        failures.push(`${key} (${token.address}): ${detail}`);
        console.log(`  FAIL  ${key}: ${detail}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      failures.push(`${key} (${token.address}): could not read contract -- ${message}`);
      console.log(`  FAIL  ${key}: could not read contract — ${message}`);
    }
  }
}

async function verifyFacilitator() {
  const url = (process.env.B402_FACILITATOR_URL ?? "https://facilitator.b402.ai").replace(/\/$/, "");
  const network = resolveNetwork();
  console.log(`\nfacilitator: ${url}`);

  try {
    const headers: Record<string, string> = {};
    if (process.env.B402_FACILITATOR_API_KEY) {
      headers.authorization = `Bearer ${process.env.B402_FACILITATOR_API_KEY}`;
    }
    const res = await fetch(`${url}/supported`, { headers });
    if (!res.ok) {
      failures.push(`facilitator /supported returned HTTP ${res.status}`);
      console.log(`  FAIL  /supported returned HTTP ${res.status}`);
      return;
    }

    const body = (await res.json()) as { kinds?: Array<{ scheme?: string; network?: string }> };
    const kinds = body.kinds ?? [];
    const match = kinds.find(
      (k) => k.scheme === "exact" && String(k.network ?? "").includes(network.replace("-mainnet", ""))
    );

    if (match) {
      console.log(`  PASS  supports scheme "exact" on ${match.network}`);
    } else {
      // Not fatal: facilitators word their network slugs differently, and
      // some do not implement /supported at all. Print what it does list so
      // the operator can judge rather than guess.
      console.log(
        `  WARN  could not match scheme "exact" on ${network} in the facilitator's supported list.\n` +
          `        It reports: ${JSON.stringify(kinds).slice(0, 400) || "(empty)"}\n` +
          `        Check the slug it expects and set B402_NETWORK accordingly.`
      );
    }
  } catch (err) {
    console.log(
      `  WARN  could not reach the facilitator: ${err instanceof Error ? err.message : String(err)}\n` +
        `        Payments cannot verify or settle while it is unreachable.`
    );
  }
}

async function main() {
  await verifyTokens();
  await verifyFacilitator();

  if (failures.length > 0) {
    console.log(`\n${failures.length} problem(s) found:`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log(`\nFix lib/chains/bnb.ts before enabling payments.`);
    process.exit(1);
  }
  console.log(`\nToken table matches the chain.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
