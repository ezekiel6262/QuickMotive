import { NextResponse } from "next/server";
import type { ServiceType } from "@/lib/supabase/types";
import { getToolDefinition } from "@/lib/a2mcp/registry";
import {
  getChainConfig,
  getSettlementToken,
  resolveNetwork,
  toAtomicUnits,
  type BnbNetwork
} from "@/lib/chains/bnb";
import { consumeCredits, getCreditBalance, issueCredit, normalizeWallet } from "@/lib/payments/credits";

/**
 * x402 / b402 payment gate for every priced route in this suite.
 *
 * Flow per the x402 spec, which b402 implements for BNB Chain:
 *   1. Buyer calls the route with no `X-PAYMENT` header.
 *   2. We answer 402 with an `accepts` list -- one PaymentRequirements per
 *      settlement token we take, priced for *this* request.
 *   3. Buyer re-sends with `X-PAYMENT`: base64 of a PaymentPayload holding
 *      an EIP-712-signed transfer authorization.
 *   4. We POST it to the facilitator's /verify BEFORE doing any work, so a
 *      bad signature costs us no Gemini/Veo/Stability spend.
 *   5. On success we POST /settle and return the receipt in
 *      `X-PAYMENT-RESPONSE`. Work first, settle after: a failed job must
 *      not take the buyer's money.
 *
 * b402 vs. plain x402: identical wire format, different settlement
 * mechanics underneath (a relayer contract instead of EIP-3009, so plain
 * BEP-20 tokens like BSC USDT work and the payer pays no gas). Nothing in
 * this file needs to know that -- it's the facilitator's job.
 *
 * Disabled by default (`X402_ENABLED` unset) so the existing OKX A2MCP
 * deployment keeps behaving exactly as it did; the gate becomes a no-op
 * that reports `settled: false`.
 */

const X402_VERSION = 1;
const DEFAULT_FACILITATOR = "https://facilitator.b402.ai";
const DEFAULT_TIMEOUT_SECONDS = 300;

export interface PaymentRequirements {
  scheme: "exact";
  network: BnbNetwork;
  /**
   * v1 field name, which is what deployed facilitators and client SDKs read.
   * `amount` is emitted alongside it for x402 v2 consumers, which renamed
   * the same field.
   */
  maxAmountRequired: string;
  amount: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown>;
}

export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
}

/** Thrown when a priced call arrives without a usable payment. */
export class PaymentRequiredError extends Error {
  body: PaymentRequiredBody;
  constructor(body: PaymentRequiredBody) {
    super(body.error ?? "Payment required");
    this.body = body;
  }
}

export interface SettlementReceipt {
  settled: boolean;
  payer: string | null;
  transaction?: string;
  network?: string;
  /** List price for this request, before credit. */
  amount: number;
  /** Credit balance applied, reducing what had to be paid on-chain. */
  creditApplied: number;
  /** What was actually charged on-chain: `amount - creditApplied`. */
  charged: number;
  /** Credit issued back for under-delivery, once reconciled. */
  creditIssued?: number;
  currency: string;
}

export interface PaymentContext {
  /** Wallet that signed the authorization, once verified. */
  payer: string | null;
  /** Wallet the credit ledger is keyed on: the verified payer if there is
   *  one, else the wallet the caller claimed. */
  wallet: string | null;
  /** List price for this request, after quantity scaling, before credit. */
  amount: number;
  /** Credit consumed for this request. */
  creditApplied: number;
  /** Amount actually payable on-chain. */
  charged: number;
  currency: string;
  /**
   * Report what was actually delivered, so an over-charge becomes credit on
   * the buyer's next call. Call it before `settle` on any service whose
   * delivered quantity can fall short of the requested one. No-op for
   * `per_call` pricing, where quantity is always 1.
   */
  reconcile: (deliveredQuantity: number, jobId?: string) => Promise<number>;
  /** Settles the verified authorization. No-op when the gate is disabled. */
  settle: () => Promise<SettlementReceipt>;
  /**
   * Hand back credit reserved for a job that then failed. Called by
   * `withJob` on the failure path -- reserving at the gate is what stops
   * two concurrent calls being quoted the same balance.
   */
  release: () => Promise<void>;
}

export function isPaymentEnabled(): boolean {
  return process.env.X402_ENABLED === "true";
}

/**
 * The orchestrator calls service routes over HTTP like any other buyer,
 * so with the gate on it would 402 against itself. It presents this shared
 * secret instead.
 *
 * This is a hole by construction: anyone holding the token calls every
 * priced service for free. It must be a real secret, and the orchestrator
 * refuses to run at all when payments are enabled unless an operator has
 * explicitly accepted that (see `app/api/orchestrator/route.ts`).
 */
function isInternalCall(req: Request): boolean {
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!token) return false;
  const presented = req.headers.get("x-internal-service-token");
  return presented === token;
}

function facilitatorUrl(): string {
  return (process.env.B402_FACILITATOR_URL ?? DEFAULT_FACILITATOR).replace(/\/$/, "");
}

function payToAddress(): string {
  const addr = process.env.AGENT_PAYOUT_ADDRESS;
  if (!addr) {
    throw new Error("X402_ENABLED=true but AGENT_PAYOUT_ADDRESS is not set -- nothing to pay to");
  }
  return addr;
}

/**
 * Settlement currencies this deployment accepts, most-preferred first. The
 * registry prices services in USDT; anything else here is quoted at the
 * same nominal amount, which is only sound for USD-pegged stablecoins.
 */
function acceptedCurrencies(): string[] {
  const configured = process.env.B402_ACCEPTED_CURRENCIES;
  return (configured ?? "USDT,USDC")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Price a single request. `per_call` pricing ignores quantity; the
 * `per_delivered_asset` / `per_token` tiers scale by the count the buyer
 * asked for.
 *
 * This quotes the *requested* quantity, because x402 "exact" needs a fixed
 * number before the work runs while S8 (per QC-passing asset), S10 (per
 * non-colliding token) and S2 (per second Veo returned) only know their
 * real quantity afterwards. The over-charge that creates is not left
 * standing: `reconcile` credits the difference back through
 * `lib/payments/credits.ts`, applied against the buyer's next call.
 */
export function priceForRequest(serviceType: ServiceType, quantity = 1): { amount: number; currency: string } {
  const tool = getToolDefinition(serviceType);
  if (!tool) throw new Error(`No pricing registered for service "${serviceType}"`);
  const { unit, amount, currency } = tool.pricing;
  const scaled = unit === "per_call" ? amount : amount * Math.max(1, quantity);
  return { amount: Number(scaled.toFixed(6)), currency };
}

/** True for the units whose delivered quantity can fall short of the requested one. */
function isQuantityPriced(serviceType: ServiceType): boolean {
  const unit = getToolDefinition(serviceType)?.pricing.unit;
  return unit !== undefined && unit !== "per_call";
}

/**
 * How much of a charge the buyer is owed back when a call delivers less
 * than it was billed for.
 *
 * Pure, and exported, because this is the arithmetic that decides whether
 * an under-delivering call over-charges: worth testing directly rather
 * than only through a live database.
 */
/**
 * Run a credit-ledger operation without letting it take down the request.
 *
 * The ledger is an optimisation on top of payment, not payment itself: a
 * buyer with no reachable ledger should get a normal 402 at list price,
 * not a 500. Every failure here resolves in the direction that cannot
 * over-charge -- an unreadable balance means no discount is offered, and a
 * failed consumption means the credit stays in the buyer's ledger (a cost
 * to us, bounded by credit they legitimately held, rather than money taken
 * from them).
 */
async function creditSafely<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (err) {
    console.error("[x402] credit ledger unavailable, continuing without it:", err);
    return fallback;
  }
}

export function shortfallCredit(
  serviceType: ServiceType,
  chargedQuantity: number,
  deliveredQuantity: number
): number {
  if (!isQuantityPriced(serviceType)) return 0;

  const charged = Math.max(1, chargedQuantity);
  const delivered = Math.max(0, deliveredQuantity);
  if (delivered >= charged) return 0;

  const chargedPrice = priceForRequest(serviceType, charged).amount;
  // `priceForRequest` floors quantity at 1, so a call that delivered
  // nothing has to be handled explicitly -- otherwise a zero-delivery job
  // would keep one unit's worth of the buyer's money.
  const deliveredPrice = delivered === 0 ? 0 : priceForRequest(serviceType, delivered).amount;

  return Number(Math.max(0, chargedPrice - deliveredPrice).toFixed(6));
}

export function buildPaymentRequirements(params: {
  serviceType: ServiceType;
  resource: string;
  quantity?: number;
  /**
   * Charge this instead of the computed list price -- the price net of any
   * credit balance the buyer is spending on this call.
   */
  overrideAmount?: number;
}): { accepts: PaymentRequirements[]; amount: number; currency: string } {
  const network = resolveNetwork();
  const tool = getToolDefinition(params.serviceType);
  const listPrice = priceForRequest(params.serviceType, params.quantity);
  const currency = listPrice.currency;
  const amount = params.overrideAmount ?? listPrice.amount;
  const payTo = payToAddress();

  const accepts = acceptedCurrencies().map((symbol) => {
    const token = getSettlementToken(symbol, network);
    return {
      scheme: "exact" as const,
      network,
      maxAmountRequired: toAtomicUnits(amount, token.decimals),
      amount: toAtomicUnits(amount, token.decimals),
      resource: params.resource,
      description: tool ? `${tool.name} -- ${tool.summary}` : params.serviceType,
      mimeType: "application/json",
      payTo,
      maxTimeoutSeconds: Number(process.env.B402_MAX_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT_SECONDS),
      asset: token.address,
      extra: {
        name: token.symbol,
        decimals: token.decimals,
        chainId: getChainConfig(network).chainId,
        relayer: getChainConfig(network).relayerContract,
        priceUnit: tool?.pricing.unit,
        quantity: params.quantity ?? 1,
        humanAmount: `${amount} ${currency}`,
        listAmount: listPrice.amount,
        creditApplied: Number((listPrice.amount - amount).toFixed(6))
      }
    };
  });

  return { accepts, amount, currency };
}

function decodePaymentHeader(header: string): Record<string, unknown> {
  try {
    const json = Buffer.from(header, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("X-PAYMENT header is not base64-encoded JSON");
  }
}

async function callFacilitator(
  path: "/verify" | "/settle",
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const url = `${facilitatorUrl()}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.B402_FACILITATOR_API_KEY) {
    headers.authorization = `Bearer ${process.env.B402_FACILITATOR_API_KEY}`;
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Facilitator ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Facilitator ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Gate a priced route. Call it after the body is parsed (so `quantity` is
 * known) and before any paid downstream work.
 *
 * Throws `PaymentRequiredError` when payment is missing or invalid --
 * `handleRouteError` turns that into the 402 the buyer's client expects.
 */
export async function requirePayment(
  req: Request,
  params: {
    serviceType: ServiceType;
    quantity?: number;
    /**
     * Price this call off a different registry entry. S1's video path uses
     * it to bill at S2's per-second Veo rate: same route, same job type,
     * but a request that costs ~24x the flat S1 price must not be sold at
     * the flat S1 price.
     */
    priceAs?: ServiceType;
    /**
     * Wallet the caller claims, from the `x-buyer-wallet` header or the
     * body. Needed before payment to look up a credit balance. Any credit
     * applied is only honoured if the verified payer turns out to be this
     * same wallet.
     */
    buyerWallet?: string | null;
  }
): Promise<PaymentContext> {
  const pricedAs = params.priceAs ?? params.serviceType;
  const quantity = params.quantity ?? 1;
  const { amount, currency } = priceForRequest(pricedAs, quantity);

  if (!isPaymentEnabled() || isInternalCall(req)) {
    return {
      payer: null,
      wallet: params.buyerWallet ?? null,
      amount,
      creditApplied: 0,
      charged: amount,
      currency,
      reconcile: async () => 0,
      release: async () => {},
      settle: async () => ({
        settled: false,
        payer: null,
        amount,
        creditApplied: 0,
        charged: amount,
        currency
      })
    };
  }

  // Credit from a previous under-delivery reduces what has to be paid
  // on-chain. Read against the claimed wallet, honoured only if that
  // wallet turns out to be the one that signed (checked after /verify).
  const claimedWallet = params.buyerWallet ? normalizeWallet(params.buyerWallet) : null;
  const balance = claimedWallet ? await creditSafely(() => getCreditBalance(claimedWallet, currency), 0) : 0;
  const creditQuote = Math.min(amount, balance);
  const due = Number((amount - creditQuote).toFixed(6));

  const resource = new URL(req.url).toString();
  const { accepts } = buildPaymentRequirements({
    serviceType: pricedAs,
    quantity,
    resource,
    overrideAmount: due
  });
  const firstAccept = accepts[0];
  if (!firstAccept) {
    throw new Error(
      "X402_ENABLED=true but B402_ACCEPTED_CURRENCIES resolved to no usable settlement token"
    );
  }

  // Credit covers the whole call: nothing to sign, nothing to settle.
  // Consumed now rather than after the work, so two concurrent calls can't
  // both be quoted the same balance.
  if (due <= 0 && claimedWallet) {
    const consumed = await creditSafely(() => consumeCredits({ wallet: claimedWallet, currency, amount }), 0);
    if (consumed >= amount) {
      return buildCreditOnlyContext({ wallet: claimedWallet, amount, consumed, currency, pricedAs, quantity });
    }
    // Lost a race for part of the balance -- fall through and charge the
    // remainder rather than serving the call under-paid.
    if (consumed > 0) {
      await creditSafely(
        () =>
          issueCredit({
            wallet: claimedWallet,
            currency,
            amount: consumed,
            reason: "released: credit-only quote lost a concurrent race"
          }),
        undefined
      );
    }
  }

  const header = req.headers.get("x-payment");
  if (!header) {
    throw new PaymentRequiredError({
      x402Version: X402_VERSION,
      error:
        creditQuote > 0
          ? `Payment required: ${due} ${currency} (${amount} less ${creditQuote} credit)`
          : `Payment required: ${amount} ${currency}`,
      accepts
    });
  }

  let paymentPayload: Record<string, unknown>;
  try {
    paymentPayload = decodePaymentHeader(header);
  } catch (err) {
    // A malformed header is still "you have not paid", not a server fault:
    // answer 402 with the accepts list so the client can re-encode and
    // retry, rather than 500 with nothing to act on.
    throw new PaymentRequiredError({
      x402Version: X402_VERSION,
      error: err instanceof Error ? err.message : "Malformed X-PAYMENT header",
      accepts
    });
  }

  // Settle against the requirement the buyer actually accepted (they pick
  // one token out of `accepts`), not against our first preference.
  const acceptedAsset = String(
    (paymentPayload.accepted as Record<string, unknown> | undefined)?.asset ?? firstAccept.asset
  ).toLowerCase();
  const requirement = accepts.find((a) => a.asset.toLowerCase() === acceptedAsset) ?? firstAccept;

  const verifyBody = {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements: requirement
  };

  let verified: Record<string, unknown>;
  try {
    verified = await callFacilitator("/verify", verifyBody);
  } catch (err) {
    throw new PaymentRequiredError({
      x402Version: X402_VERSION,
      error: `Payment verification failed: ${err instanceof Error ? err.message : String(err)}`,
      accepts
    });
  }

  if (verified.isValid !== true) {
    throw new PaymentRequiredError({
      x402Version: X402_VERSION,
      error: `Payment rejected: ${String(verified.invalidReason ?? "facilitator returned isValid=false")}`,
      accepts
    });
  }

  const payer = typeof verified.payer === "string" ? verified.payer : null;

  // A credit belongs to the wallet that earned it. If the signer is not the
  // wallet the request claimed, the discount was not theirs to spend --
  // re-quote at full price rather than serving it.
  if (creditQuote > 0 && (!payer || normalizeWallet(payer) !== claimedWallet)) {
    const { accepts: fullPrice } = buildPaymentRequirements({
      serviceType: pricedAs,
      quantity,
      resource,
      overrideAmount: amount
    });
    throw new PaymentRequiredError({
      x402Version: X402_VERSION,
      error: `Credit belongs to ${claimedWallet}, but the payment was signed by ${payer ?? "an unknown wallet"}. Re-quoted at full price.`,
      accepts: fullPrice
    });
  }

  const creditApplied =
    creditQuote > 0
      ? await creditSafely(() => consumeCredits({ wallet: claimedWallet!, currency, amount: creditQuote }), 0)
      : 0;
  const wallet = payer ? normalizeWallet(payer) : claimedWallet;
  let creditIssued = 0;

  return {
    payer,
    wallet,
    amount,
    creditApplied,
    charged: Number((amount - creditApplied).toFixed(6)),
    currency,

    reconcile: async (deliveredQuantity: number, jobId?: string) => {
      if (!wallet) return 0;

      // Charged for `quantity`, delivered less. The difference is the
      // buyer's, and becomes credit against their next call.
      const delivered = Math.max(0, deliveredQuantity);
      const shortfall = shortfallCredit(pricedAs, quantity, delivered);
      if (shortfall <= 0) return 0;

      const ok = await creditSafely(
        () =>
          issueCredit({
            wallet,
            currency,
            amount: shortfall,
            reason: `under-delivery on ${params.serviceType}: charged for ${quantity}, delivered ${delivered}`,
            jobId
          }).then(() => true),
        false
      );
      if (!ok) return 0;
      creditIssued = shortfall;
      return shortfall;
    },

    release: async () => {
      if (creditApplied > 0 && wallet) {
        await issueCredit({
          wallet,
          currency,
          amount: creditApplied,
          reason: "released: job failed after credit was reserved"
        });
      }
    },

    settle: async () => {
      const settled = await callFacilitator("/settle", verifyBody);
      if (settled.success !== true) {
        throw new Error(`Settlement failed: ${String(settled.errorReason ?? "facilitator returned success=false")}`);
      }
      return {
        settled: true,
        payer: typeof settled.payer === "string" ? settled.payer : payer,
        transaction: typeof settled.transaction === "string" ? settled.transaction : undefined,
        network: typeof settled.network === "string" ? settled.network : requirement.network,
        amount,
        creditApplied,
        charged: Number((amount - creditApplied).toFixed(6)),
        creditIssued: creditIssued > 0 ? creditIssued : undefined,
        currency
      };
    }
  };
}

/** Call fully covered by credit: no signature, no on-chain settlement. */
function buildCreditOnlyContext(params: {
  wallet: string;
  amount: number;
  consumed: number;
  currency: string;
  pricedAs: ServiceType;
  quantity: number;
}): PaymentContext {
  const { wallet, amount, consumed, currency, pricedAs, quantity } = params;
  let creditIssued = 0;

  return {
    payer: null,
    wallet,
    amount,
    creditApplied: consumed,
    charged: 0,
    currency,
    reconcile: async (deliveredQuantity: number, jobId?: string) => {
      const delivered = Math.max(0, deliveredQuantity);
      const shortfall = shortfallCredit(pricedAs, quantity, delivered);
      if (shortfall <= 0) return 0;
      const ok = await creditSafely(
        () =>
          issueCredit({
            wallet,
            currency,
            amount: shortfall,
            reason: `under-delivery on ${pricedAs}: charged for ${quantity}, delivered ${delivered}`,
            jobId
          }).then(() => true),
        false
      );
      if (!ok) return 0;
      creditIssued = shortfall;
      return shortfall;
    },
    release: async () => {
      await issueCredit({
        wallet,
        currency,
        amount: consumed,
        reason: "released: job failed after credit was reserved"
      });
    },
    settle: async () => ({
      settled: false,
      payer: null,
      amount,
      creditApplied: consumed,
      charged: 0,
      creditIssued: creditIssued > 0 ? creditIssued : undefined,
      currency
    })
  };
}

/**
 * Attach the settlement receipt to a successful response, per x402's
 * `X-PAYMENT-RESPONSE` convention (base64 JSON).
 */
export function withPaymentReceipt(res: NextResponse, receipt: SettlementReceipt): NextResponse {
  if (!receipt.settled) return res;
  res.headers.set("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(receipt)).toString("base64"));
  return res;
}

/**
 * Settle without letting a settlement error destroy an already-completed
 * job's output. The buyer gets their deliverable and we get a job row
 * flagged unsettled -- far better than a 500 that loses the assets we
 * already paid providers to generate.
 */
export async function settleQuietly(payment: PaymentContext): Promise<SettlementReceipt> {
  try {
    return await payment.settle();
  } catch (err) {
    console.error("[x402] settlement failed after successful job:", err);
    return {
      settled: false,
      payer: payment.payer,
      amount: payment.amount,
      creditApplied: payment.creditApplied,
      charged: payment.charged,
      currency: payment.currency
    };
  }
}

export function paymentRequiredResponse(err: PaymentRequiredError): NextResponse {
  return NextResponse.json(err.body, { status: 402 });
}
