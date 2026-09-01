-- Payment credits: the fix for x402's fixed-amount constraint.
--
-- x402's "exact" scheme settles a signed authorization for one fixed
-- amount, decided before the work runs. Several services here only know
-- their real quantity afterwards -- S8 prices per QC-passing asset, S10 per
-- non-colliding token, S2 per second of video Veo actually returned. The
-- gap is always in the same direction: the buyer is charged for what they
-- requested and sometimes receives less.
--
-- Refunding on-chain would mean a hot wallet, gas, and a transfer path for
-- amounts often worth less than the gas to send them. Instead the shortfall
-- is recorded here and applied against the buyer's next call, which needs
-- no on-chain machinery and leaves an auditable row per adjustment.
--
-- Credits are denominated in the settlement currency, keyed by the wallet
-- that provably signed the payment.

create table payment_credits (
  id uuid primary key default gen_random_uuid(),
  -- Lower-cased address. The application normalizes before writing, so
  -- checksummed and lower-case spellings of one wallet share a balance.
  buyer_wallet text not null,
  currency text not null,
  -- Face value when issued, kept for audit even after it is spent.
  amount numeric(20, 6) not null check (amount > 0),
  -- Unspent portion. Drains to zero as later calls consume it.
  remaining numeric(20, 6) not null check (remaining >= 0),
  reason text not null,
  -- The job whose under-delivery created this credit, or that spent it.
  job_id uuid references jobs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint remaining_within_amount check (remaining <= amount)
);

-- The hot path is "what does this wallet have left in this currency", run
-- on every priced request, so index exactly that and skip spent rows.
create index payment_credits_open_balance_idx
  on payment_credits (buyer_wallet, currency)
  where remaining > 0;

create index payment_credits_job_idx on payment_credits (job_id);

create trigger payment_credits_set_updated_at
  before update on payment_credits
  for each row
  execute function set_updated_at();

-- Ledger of credit spends, so a balance can be reconstructed rather than
-- inferred from the current `remaining` values alone.
create table payment_credit_redemptions (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references payment_credits (id) on delete cascade,
  job_id uuid references jobs (id) on delete set null,
  amount numeric(20, 6) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index payment_credit_redemptions_credit_idx
  on payment_credit_redemptions (credit_id);
