import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Service-role Supabase client for use inside API routes only. Never import
 * this from client components -- the service role key bypasses RLS.
 *
 * Deliberately untyped against the hand-maintained `Database` interface in
 * `./types.ts`: the installed postgrest-js version's generic schema shape
 * (GenericTable with Relationships) is stricter than a hand-rolled mirror
 * can satisfy without drift. Callers should type query results against the
 * row interfaces in `./types.ts` explicitly. Regenerate a real `Database`
 * type with `supabase gen types typescript` once a live project exists and
 * wire it back in here.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use the admin client"
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return cached;
}
