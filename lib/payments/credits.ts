import { getSupabaseAdmin } from "@/lib/supabase/client";

/**
 * Buyer credit ledger.
 *
 * x402's "exact" scheme settles one fixed amount, signed before the work
 * runs. S8 (per QC-passing asset), S10 (per non-colliding token) and S2
 * (per second of video actually returned) only learn their real quantity
 * afterwards, and the gap always runs one way: the buyer paid for the
 * count they requested and sometimes got less.
 *
 * Rather than refund on-chain -- a hot wallet, gas, and transfers often
 * worth less than the gas to send them -- the shortfall is credited here
 * and applied to the buyer's next call. Every adjustment is a row, so the
 * arithmetic is auditable instead of implicit.
 *
 * Ordering: credits are consumed at the gate, once payment verifies and
 * before any work starts, and released if the job then fails. Consuming
 * after the fact would let two concurrent calls each be quoted the same
 * balance and both spend it.
 */

/** Addresses arrive checksummed or lower-cased; one wallet, one balance. */
export function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

/** Money is rounded to the cent everywhere it is written or compared. */
function round(amount: number): number {
  return Math.round(amount * 1e6) / 1e6;
}

export async function getCreditBalance(wallet: string, currency: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("payment_credits")
    .select("remaining")
    .eq("buyer_wallet", normalizeWallet(wallet))
    .eq("currency", currency)
    .gt("remaining", 0);

  if (error) throw new Error(`Failed to read credit balance: ${error.message}`);
  return round((data ?? []).reduce((sum, row) => sum + Number(row.remaining), 0));
}

/**
 * Spend up to `amount` of a wallet's credit, oldest first. Returns what was
 * actually consumed, which can be less than requested if a concurrent call
 * drained the balance first -- callers must price off the return value, not
 * off the balance they read earlier.
 *
 * Each row is updated with an optimistic guard on the `remaining` value it
 * was read at, so a concurrent spend loses the race and retries against
 * fresh state instead of double-spending.
 */
export async function consumeCredits(params: {
  wallet: string;
  currency: string;
  amount: number;
  jobId?: string;
}): Promise<number> {
  if (params.amount <= 0) return 0;
  const supabase = getSupabaseAdmin();
  const wallet = normalizeWallet(params.wallet);

  let outstanding = round(params.amount);
  let consumed = 0;

  // Bounded: each pass either spends from a row or loses a race on it.
  for (let attempt = 0; attempt < 5 && outstanding > 0; attempt++) {
    const { data: credits, error } = await supabase
      .from("payment_credits")
      .select("id, remaining")
      .eq("buyer_wallet", wallet)
      .eq("currency", params.currency)
      .gt("remaining", 0)
      .order("created_at", { ascending: true })
      .limit(20);

    if (error) throw new Error(`Failed to read credits: ${error.message}`);
    if (!credits || credits.length === 0) break;

    let progressed = false;

    for (const credit of credits) {
      if (outstanding <= 0) break;
      const available = Number(credit.remaining);
      const take = round(Math.min(available, outstanding));
      if (take <= 0) continue;

      const { data: updated, error: updateError } = await supabase
        .from("payment_credits")
        .update({ remaining: round(available - take) })
        .eq("id", credit.id)
        .eq("remaining", credit.remaining) // optimistic guard
        .select("id");

      if (updateError) throw new Error(`Failed to consume credit: ${updateError.message}`);
      if (!updated || updated.length === 0) continue; // lost the race, retry

      await supabase.from("payment_credit_redemptions").insert({
        credit_id: credit.id,
        job_id: params.jobId ?? null,
        amount: take
      });

      outstanding = round(outstanding - take);
      consumed = round(consumed + take);
      progressed = true;
    }

    if (!progressed) break;
  }

  return consumed;
}

/**
 * Put credit into a wallet's balance: an under-delivery adjustment, or the
 * release of credit reserved for a job that then failed.
 */
export async function issueCredit(params: {
  wallet: string;
  currency: string;
  amount: number;
  reason: string;
  jobId?: string;
}): Promise<void> {
  const amount = round(params.amount);
  if (amount <= 0) return;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("payment_credits").insert({
    buyer_wallet: normalizeWallet(params.wallet),
    currency: params.currency,
    amount,
    remaining: amount,
    reason: params.reason,
    job_id: params.jobId ?? null
  });

  if (error) throw new Error(`Failed to issue credit: ${error.message}`);
}
