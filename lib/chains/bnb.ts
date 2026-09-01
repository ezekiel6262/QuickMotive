/**
 * BNB Smart Chain constants for the BNB Agent Studio deployment.
 *
 * Two things live here and nowhere else, so a chain/token change is a
 * one-file edit:
 *  - the chain identifiers the agent card and x402/b402 payloads quote
 *    (CAIP-2 for the agent card, b402's own network slug for payments)
 *  - the settlement token table
 *
 * Decimals matter and are easy to get wrong: BEP-20 USDT and USDC on BSC
 * are 18-decimal, unlike their 6-decimal Ethereum/Base counterparts. Every
 * x402 `amount` is in atomic units, so a wrong `decimals` here is a
 * 10^12x mispricing, not a rounding error.
 *
 * Token addresses below are the well-known BSC mainnet deployments.
 * Re-verify each against BscScan before pointing real settlement at them --
 * this file is the single place to do it.
 */

export type BnbNetwork = "bsc-mainnet" | "bsc-testnet";

export interface BnbChainConfig {
  /** b402/x402 `network` slug quoted in PaymentRequirements. */
  network: BnbNetwork;
  chainId: number;
  /** CAIP-2 identifier, used by the ERC-8004 agent card. */
  caip2: string;
  name: string;
  defaultRpcUrl: string;
  explorerUrl: string;
  /**
   * b402 Relayer contract: the piece that makes x402 work for plain BEP-20
   * tokens. Canonical x402 "exact" settles via EIP-3009
   * `transferWithAuthorization`, which BSC USDT does not implement; b402
   * routes the EIP-712-signed authorization through this relayer instead,
   * which also means the payer spends no gas.
   */
  relayerContract: string;
}

export const BSC_MAINNET: BnbChainConfig = {
  network: "bsc-mainnet",
  chainId: 56,
  caip2: "eip155:56",
  name: "BNB Smart Chain",
  defaultRpcUrl: "https://bsc-dataseed.bnbchain.org",
  explorerUrl: "https://bscscan.com",
  relayerContract: "0xE1C2830d5DDd6B49E9c46EbE03a98Cb44CD8eA5a"
};

export const BSC_TESTNET: BnbChainConfig = {
  network: "bsc-testnet",
  chainId: 97,
  caip2: "eip155:97",
  name: "BNB Smart Chain Testnet",
  defaultRpcUrl: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  explorerUrl: "https://testnet.bscscan.com",
  relayerContract: "0xd67eF16fa445101Ef1e1c6A9FB9F3014f1d60DE6"
};

export interface TokenConfig {
  symbol: string;
  address: string;
  decimals: number;
}

/**
 * Settlement tokens b402 supports on BSC mainnet. All 18-decimal -- see the
 * header note. USD1 is included because BNB Agent Studio listings quote it
 * alongside USDT; drop it from a listing rather than editing prices if a
 * buyer base never uses it.
 */
export const BSC_MAINNET_TOKENS: Record<string, TokenConfig> = {
  USDT: { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  USDC: { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
  USD1: { symbol: "USD1", address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", decimals: 18 }
};

/**
 * Testnet has no canonical stablecoin set worth hardcoding -- point
 * `B402_ASSET_ADDRESS` at whatever faucet token the b402 testnet
 * facilitator accepts.
 */
export const BSC_TESTNET_TOKENS: Record<string, TokenConfig> = {};

export function getChainConfig(network: BnbNetwork = resolveNetwork()): BnbChainConfig {
  return network === "bsc-testnet" ? BSC_TESTNET : BSC_MAINNET;
}

export function resolveNetwork(): BnbNetwork {
  const configured = process.env.B402_NETWORK;
  return configured === "bsc-testnet" ? "bsc-testnet" : "bsc-mainnet";
}

/**
 * Resolve the settlement token for a currency symbol. `B402_ASSET_ADDRESS`
 * / `B402_ASSET_DECIMALS` override the table entirely, which is how
 * testnet and any not-yet-listed token are configured without a code change.
 */
export function getSettlementToken(symbol: string, network: BnbNetwork = resolveNetwork()): TokenConfig {
  const override = process.env.B402_ASSET_ADDRESS;
  if (override) {
    return {
      symbol,
      address: override,
      decimals: Number(process.env.B402_ASSET_DECIMALS ?? 18)
    };
  }

  const table = network === "bsc-testnet" ? BSC_TESTNET_TOKENS : BSC_MAINNET_TOKENS;
  const token = table[symbol.toUpperCase()];
  if (!token) {
    throw new Error(
      `No ${network} settlement token configured for "${symbol}". ` +
        `Known: ${Object.keys(table).join(", ") || "(none)"}. ` +
        `Set B402_ASSET_ADDRESS/B402_ASSET_DECIMALS to override.`
    );
  }
  return token;
}

/**
 * Decimal price -> atomic units, done as string arithmetic. `0.35 * 1e18`
 * in floating point is 349999999999999994, which a facilitator will happily
 * settle as a different amount than the one advertised.
 */
export function toAtomicUnits(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Cannot convert ${amount} to atomic units`);
  }
  // Enough precision for any price this suite quotes; trailing zeros are
  // stripped so the split below never sees exponent notation.
  const fixed = amount.toFixed(Math.min(decimals, 12));
  const [whole, fraction = ""] = fixed.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const atomic = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return atomic;
}
