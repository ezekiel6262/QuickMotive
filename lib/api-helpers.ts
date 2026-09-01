import { NextResponse } from "next/server";
import type { ZodType, ZodTypeDef } from "zod";
import { PaymentRequiredError, paymentRequiredResponse } from "@/lib/payments/x402";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * `ZodType<T, ZodTypeDef, any>` rather than `ZodSchema<T>`: schemas with
 * `.default(...)` fields have an Input type that differs from their Output
 * type (fields are optional pre-parse, required post-parse). `ZodSchema<T>`
 * pins Input = Output = T, which rejects exactly those schemas. Callers pass
 * an explicit `parseBody<z.infer<typeof schema>>(req, schema)` so T binds to
 * the Output type.
 */
export async function parseBody<T>(req: Request, schema: ZodType<T, ZodTypeDef, any>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ApiError(400, `Invalid request body: ${result.error.message}`);
  }
  return result.data;
}

export function handleRouteError(err: unknown): NextResponse {
  // x402/b402: a missing or rejected payment is a 402 carrying the
  // `accepts` list, not an error page -- the buyer's client reads it,
  // signs an authorization, and retries.
  if (err instanceof PaymentRequiredError) {
    return paymentRequiredResponse(err);
  }
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "Internal error";
  console.error(err);
  return NextResponse.json({ error: message }, { status: 500 });
}

/**
 * Every call is expected to carry the buyer's wallet address so the job row
 * can be attributed for settlement. Three sources, in order of trust:
 *
 *  1. `payerWallet` -- the address the b402 facilitator cryptographically
 *     verified signed the payment authorization. On the BNB Agent Studio
 *     path this is the only self-proving one, so it wins.
 *  2. `x-buyer-wallet` -- injected by OKX's A2MCP envelope.
 *  3. `buyer_wallet` in the body -- local testing.
 */
export function requireBuyerWallet(req: Request, bodyWallet?: string, payerWallet?: string | null): string {
  const header = req.headers.get("x-buyer-wallet");
  const wallet = payerWallet ?? header ?? bodyWallet;
  if (!wallet) {
    throw new ApiError(
      400,
      "Missing buyer wallet (verified x402 payer, x-buyer-wallet header, or buyer_wallet field)"
    );
  }
  return wallet;
}
