import { timingSafeEqual } from "node:crypto";

/**
 * Access control for the ops-only admin routes.
 *
 * Pulled out of the route handler so it can be unit tested: this is the
 * only thing standing between a public deployment and an endpoint that
 * returns real exchange account balances, and "I poked it with curl once"
 * is not adequate coverage for that.
 *
 * Fails closed in both directions:
 *  - no token configured -> 404, so an unconfigured ops endpoint does not
 *    exist rather than inviting guesses with a 401
 *  - token configured -> constant-time compare, so a wrong guess leaks
 *    nothing about the expected value through response timing
 */
export type AdminAuthResult = { ok: true } | { ok: false; status: 404 | 401; message: string };

export function checkAdminAuth(
  authorizationHeader: string | null,
  expectedToken: string | undefined
): AdminAuthResult {
  if (!expectedToken) {
    return { ok: false, status: 404, message: "Not found" };
  }

  const header = authorizationHeader ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  // Length is compared first and separately: timingSafeEqual throws on a
  // length mismatch, and padding to a common length before comparing would
  // make a short guess indistinguishable from a wrong one of the right
  // length. Length is not the secret; the bytes are.
  if (presented.length !== expectedToken.length) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  const equal = timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(expectedToken, "utf8"));
  return equal ? { ok: true } : { ok: false, status: 401, message: "Unauthorized" };
}
