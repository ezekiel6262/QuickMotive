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
  /** Human-readable price actually charged, for the job row. */
  amount: number;
  currency: string;
}

export interface PaymentContext {
  /** Wallet that signed the authorization, once verified. */
  payer: string | null;
  /** Price charged for this specific request, after quantity scaling. */
  amount: number;
  currency: string;
  /** Settles the verified authorization. No-op when the gate is disabled. */
  settle: () => Promise<SettlementReceipt>;
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
 * Note the mismatch this papers over: S8 prices per *passing* asset and
 * S10 per *non-colliding* token, neither of which is known until the work
 * is done, while x402 "exact" needs a number up front. Charging for the
 * requested count is the honest-to-the-buyer direction only if overcharge
 * is refunded -- see the README's "Known integration gaps".
 */
export function priceForRequest(serviceType: ServiceType, quantity = 1): { amount: number; currency: string } {
  const tool = getToolDefinition(serviceType);
  if (!tool) throw new Error(`No pricing registered for service "${serviceType}"`);
  const { unit, amount, currency } = tool.pricing;
  const scaled = unit === "per_call" ? amount : amount * Math.max(1, quantity);
  return { amount: Number(scaled.toFixed(6)), currency };
}

export function buildPaymentRequirements(params: {
  serviceType: ServiceType;
  resource: string;
  quantity?: number;
}): { accepts: PaymentRequirements[]; amount: number; currency: string } {
  const network = resolveNetwork();
  const tool = getToolDefinition(params.serviceType);
  const { amount, currency } = priceForRequest(params.serviceType, params.quantity);
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
        humanAmount: `${amount} ${currency}`
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
  params: { serviceType: ServiceType; quantity?: number }
): Promise<PaymentContext> {
  const { amount, currency } = priceForRequest(params.serviceType, params.quantity);

  if (!isPaymentEnabled() || isInternalCall(req)) {
    return {
      payer: null,
      amount,
      currency,
      settle: async () => ({ settled: false, payer: null, amount, currency })
    };
  }

  const resource = new URL(req.url).toString();
  const { accepts } = buildPaymentRequirements({ ...params, resource });
  const firstAccept = accepts[0];
  if (!firstAccept) {
    throw new Error(
      "X402_ENABLED=true but B402_ACCEPTED_CURRENCIES resolved to no usable settlement token"
    );
  }

  const header = req.headers.get("x-payment");
  if (!header) {
    throw new PaymentRequiredError({
      x402Version: X402_VERSION,
      error: `Payment required: ${amount} ${currency}`,
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

  return {
    payer,
    amount,
    currency,
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
        currency
      };
    }
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
    return { settled: false, payer: payment.payer, amount: payment.amount, currency: payment.currency };
  }
}

export function paymentRequiredResponse(err: PaymentRequiredError): NextResponse {
  return NextResponse.json(err.body, { status: 402 });
}
