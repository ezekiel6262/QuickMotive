import { getSupabaseAdmin } from "@/lib/supabase/client";
import type { JobRow, JobStatus, ServiceType } from "@/lib/supabase/types";

/**
 * Shared job lifecycle helper. Every service route creates one job row up
 * front (status "running"), then marks it succeeded/failed on completion.
 * This is the audit/settlement anchor referenced in the data model -- OKX
 * A2MCP settlement should key off `price_paid` on the same row.
 */
export async function createJob(params: {
  serviceType: ServiceType;
  buyerWallet: string;
  input: Record<string, unknown>;
  pricePaid?: number;
  priceCurrency?: string;
}): Promise<JobRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      service_type: params.serviceType,
      buyer_wallet: params.buyerWallet,
      status: "running",
      input: params.input,
      price_paid: params.pricePaid ?? null,
      price_currency: params.priceCurrency ?? "USDT"
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to create job: ${error?.message ?? "unknown error"}`);
  }
  return data;
}

export async function completeJob(
  jobId: string,
  output: Record<string, unknown>,
  status: JobStatus = "succeeded"
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("jobs").update({ status, output }).eq("id", jobId);
  if (error) throw new Error(`Failed to complete job ${jobId}: ${error.message}`);
}

export async function failJob(jobId: string, err: unknown): Promise<void> {
  const supabase = getSupabaseAdmin();
  const message = err instanceof Error ? err.message : String(err);
  const { error } = await supabase.from("jobs").update({ status: "failed", error: message }).eq("id", jobId);
  if (error) throw new Error(`Failed to mark job ${jobId} failed: ${error.message}`);
}

/** Wraps a service handler so every route gets consistent job bookkeeping. */
export async function withJob<T extends Record<string, unknown>>(
  params: {
    serviceType: ServiceType;
    buyerWallet: string;
    input: Record<string, unknown>;
    /**
     * The call's payment context. Its price is recorded on the row up
     * front, so the row anchors settlement even if the x402 settle step
     * later fails -- an unsettled job is then a queryable state, not a
     * silent zero. On failure, any credit the gate reserved for this call
     * is released back to the buyer here, which is why the context is
     * passed in rather than the bare numbers.
     */
    payment?: {
      amount: number;
      currency: string;
      release: () => Promise<void>;
    };
  },
  handler: (jobId: string) => Promise<T>
): Promise<{ job_id: string; output: T }> {
  const job = await createJob({
    serviceType: params.serviceType,
    buyerWallet: params.buyerWallet,
    input: params.input,
    pricePaid: params.payment?.amount,
    priceCurrency: params.payment?.currency
  });

  try {
    const output = await handler(job.id);
    await completeJob(job.id, output);
    return { job_id: job.id, output };
  } catch (err) {
    await failJob(job.id, err);
    // The buyer paid nothing on-chain (settlement only runs on success),
    // but credit was already spent at the gate -- give it back. A failure
    // here must not mask the original error.
    if (params.payment) {
      try {
        await params.payment.release();
      } catch (releaseErr) {
        console.error(`[jobs] failed to release credit for job ${job.id}:`, releaseErr);
      }
    }
    throw err;
  }
}
