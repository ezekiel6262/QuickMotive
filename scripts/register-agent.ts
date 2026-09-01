/**
 * Register QuickMotive in the ERC-8004 Identity Registry on BNB Smart Chain.
 *
 *   npm run agent:register            # preflight + simulate, sends nothing
 *   npm run agent:register -- --confirm   # actually broadcasts
 *
 * ERC-8004 registration is an ERC-721 mint whose `tokenURI` resolves to the
 * agent card. Everything discovery-side (BNB Agent Studio, ERC-8004
 * indexers, marketplace listings) keys off that token, so this is the step
 * that turns a deployed Next.js app into an on-chain agent identity.
 *
 * Two deliberate safety properties, because this spends real BNB against an
 * address the operator supplies:
 *
 *  - Nothing is broadcast without `--confirm`. The default run does every
 *    check and a full `simulateContract`, then stops.
 *  - The registry address is required from env with no default. The ERC-8004
 *    draft's canonical deployments differ per chain and have moved between
 *    revisions; a hardcoded guess here would send a mint to whatever
 *    contract happens to sit at that address on BSC. Read it off the
 *    ERC-8004 deployment table, verify it on BscScan, then set it.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";

const CONFIRM = process.argv.includes("--confirm");

/**
 * The draft has revised `register`'s signature more than once and
 * deployments in the wild disagree. Rather than pin one, simulate each in
 * order and use the first the deployed contract actually accepts -- the
 * simulation is free and tells us definitively which ABI is live.
 */
const REGISTER_VARIANTS: Array<{
  label: string;
  functionName: string;
  abi: Abi;
  args: (uri: string) => readonly unknown[];
}> = [
  {
    label: "register(string)",
    functionName: "register",
    abi: [
      {
        type: "function",
        name: "register",
        stateMutability: "nonpayable",
        inputs: [{ name: "tokenURI", type: "string" }],
        outputs: [{ name: "agentId", type: "uint256" }]
      }
    ],
    args: (uri) => [uri]
  },
  {
    label: "register(string,address)",
    functionName: "register",
    abi: [
      {
        type: "function",
        name: "register",
        stateMutability: "nonpayable",
        inputs: [
          { name: "tokenURI", type: "string" },
          { name: "owner", type: "address" }
        ],
        outputs: [{ name: "agentId", type: "uint256" }]
      }
    ],
    args: (uri) => [uri, process.env.AGENT_WALLET_ADDRESS as Address]
  },
  {
    label: "newAgent(string)",
    functionName: "newAgent",
    abi: [
      {
        type: "function",
        name: "newAgent",
        stateMutability: "nonpayable",
        inputs: [{ name: "agentURI", type: "string" }],
        outputs: [{ name: "agentId", type: "uint256" }]
      }
    ],
    args: (uri) => [uri]
  }
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return value;
}

async function main() {
  const network = process.env.B402_NETWORK === "bsc-testnet" ? "bsc-testnet" : "bsc-mainnet";
  const chain = network === "bsc-testnet" ? bscTestnet : bsc;
  const rpcUrl = process.env.BSC_RPC_URL ?? chain.rpcUrls.default.http[0];
  const registry = required("ERC8004_IDENTITY_REGISTRY") as Address;
  const baseUrl = required("AGENT_BASE_URL").replace(/\/$/, "");
  const cardUrl = `${baseUrl}/.well-known/agent-card.json`;

  const account = privateKeyToAccount(required("AGENT_PRIVATE_KEY") as `0x${string}`);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  console.log(`network:   ${network} (chainId ${chain.id})`);
  console.log(`rpc:       ${rpcUrl}`);
  console.log(`registry:  ${registry}`);
  console.log(`signer:    ${account.address}`);
  console.log(`agentURI:  ${cardUrl}\n`);

  // --- Preflight 1: the agent card must be live and parseable. Registering
  // a tokenURI that 404s produces an on-chain identity no indexer can read.
  const cardRes = await fetch(cardUrl);
  if (!cardRes.ok) {
    throw new Error(`Agent card is not reachable (HTTP ${cardRes.status} at ${cardUrl}). Deploy the app first.`);
  }
  const card = (await cardRes.json()) as { name?: string; skills?: unknown[] };
  if (!card.name || !Array.isArray(card.skills) || card.skills.length === 0) {
    throw new Error(`Agent card at ${cardUrl} is missing name/skills -- refusing to register it.`);
  }
  console.log(`[ok] agent card: "${card.name}", ${card.skills.length} skills`);

  // --- Preflight 2: the registry address must actually be a contract.
  const bytecode = await publicClient.getBytecode({ address: registry });
  if (!bytecode || bytecode === "0x") {
    throw new Error(
      `No contract at ${registry} on ${network}. Verify the ERC-8004 Identity Registry ` +
        `address on BscScan before setting ERC8004_IDENTITY_REGISTRY.`
    );
  }
  console.log(`[ok] registry has bytecode (${bytecode.length} chars)`);

  // --- Preflight 3: gas.
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) {
    throw new Error(`Signer ${account.address} holds 0 BNB -- fund it before registering.`);
  }
  console.log(`[ok] signer balance: ${Number(balance) / 1e18} BNB`);

  // --- Find the live `register` ABI by simulation.
  let chosen: (typeof REGISTER_VARIANTS)[number] | null = null;
  let simulation: Awaited<ReturnType<typeof publicClient.simulateContract>> | null = null;
  const failures: string[] = [];

  for (const variant of REGISTER_VARIANTS) {
    if (variant.label.includes("address") && !process.env.AGENT_WALLET_ADDRESS) continue;
    try {
      simulation = await publicClient.simulateContract({
        address: registry,
        abi: variant.abi,
        functionName: variant.functionName,
        args: variant.args(cardUrl),
        account
      });
      chosen = variant;
      break;
    } catch (err) {
      failures.push(`  ${variant.label}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }

  if (!chosen || !simulation) {
    throw new Error(
      `None of the known ERC-8004 register signatures simulated successfully against ${registry}:\n` +
        failures.join("\n") +
        `\n\nThe deployed registry may use a different ABI -- read it off BscScan and add the ` +
        `variant to REGISTER_VARIANTS in this script.`
    );
  }

  console.log(`[ok] simulated ${chosen.label} -> agentId ${String(simulation.result)}`);

  if (!CONFIRM) {
    console.log(
      `\nDry run complete. Nothing was broadcast.\n` +
        `Re-run with --confirm to send the registration transaction.`
    );
    return;
  }

  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const hash = await walletClient.writeContract(simulation.request);
  console.log(`\nsubmitted: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Registration reverted. See ${chain.blockExplorers?.default.url}/tx/${hash}`);
  }

  const agentId = String(simulation.result);
  console.log(`confirmed in block ${receipt.blockNumber}`);
  console.log(`explorer:  ${chain.blockExplorers?.default.url}/tx/${hash}\n`);
  console.log(`Set these and redeploy so the agent card advertises the registration:`);
  console.log(`  ERC8004_AGENT_ID=${agentId}`);
  console.log(`  ERC8004_IDENTITY_REGISTRY=${registry}`);
}

main().catch((err) => {
  console.error(`\nregistration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
