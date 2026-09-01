/**
 * Provider unit costs, and the prices derived from them.
 *
 * This exists because S2 shipped at a flat $0.40/call against a Veo clip
 * that costs up to $1.20 to produce. On the OKX path that was an invoicing
 * problem someone would eventually notice; on the BNB path the price is
 * collected on-chain per call, so every request would settle at a loss with
 * nothing downstream to catch it.
 *
 * The fix is structural, not a new magic number: costs live here as data,
 * buyer-facing prices are computed from them, and `npm run verify:pricing`
 * fails the build if any price stops covering its worst-case cost. A
 * provider price change is then a one-line edit that propagates to the
 * registry, the agent card, and both marketplace listings.
 *
 * Only costs this repo has actually sourced are listed. Everything else is
 * deliberately absent rather than guessed -- an unverified cost in this
 * table would produce confidently wrong prices, which is worse than the
 * flat placeholders it replaced.
 */

/**
 * Worst-case provider cost per unit, in USD.
 *
 * Veo figures are the ones documented in `lib/clients/veo.ts`, taken from
 * Google's published per-second pricing. The fast tier is quoted as a
 * ~$0.10-0.15/sec range; the top of the range is used, because pricing off
 * the bottom of a range loses money on every call that lands above it.
 */
export const PROVIDER_UNIT_COSTS = {
  /** veo-3.1-fast-generate-preview, per second of output. */
  veo_fast_per_second: numberFromEnv("COST_VEO_FAST_PER_SECOND", 0.15),
  /** veo-3.1 standard, per second. Not currently used -- here so switching
   *  tiers is a cost-table edit rather than a silent margin collapse. */
  veo_standard_per_second: numberFromEnv("COST_VEO_STANDARD_PER_SECOND", 0.4)
} as const;

export type CostKey = keyof typeof PROVIDER_UNIT_COSTS;

/**
 * Gross margin over worst-case provider cost. 0.6 = price is cost x 1.6.
 *
 * It has to cover more than the provider invoice: Supabase storage and
 * egress for every generated asset, the Anthropic calls several services
 * make for planning/extraction, and the failed generations that are paid
 * for but never delivered.
 */
export const PRICE_MARGIN = numberFromEnv("PRICE_MARGIN", 0.6);

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  }
  return parsed;
}

/** Round up to the cent. Rounding down would reintroduce the loss. */
function ceilToCent(value: number): number {
  return Math.ceil(value * 100) / 100;
}

/** Buyer-facing price for one unit of something with a known provider cost. */
export function priceFromCost(key: CostKey): number {
  return ceilToCent(PROVIDER_UNIT_COSTS[key] * (1 + PRICE_MARGIN));
}

/**
 * Per-second price for Veo output. Both S2 and S1's video path bill through
 * this, so they cannot drift apart.
 */
export const VEO_PRICE_PER_SECOND = priceFromCost("veo_fast_per_second");

/**
 * `lib/clients/veo.ts` defaults to 6 seconds when the caller doesn't ask
 * for a duration -- which is exactly what S1's video path does, since its
 * schema has no duration field. Quoting a price means knowing that number,
 * so it is named here rather than re-derived.
 */
export const VEO_DEFAULT_DURATION_SECONDS = 6;
