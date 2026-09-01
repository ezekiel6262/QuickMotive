import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { checkAdminAuth } from "../lib/admin-auth";

const TOKEN = "correct-horse-battery-staple";

describe("checkAdminAuth", () => {
  it("404s when no token is configured, whatever is presented", () => {
    // An unconfigured ops endpoint should not exist. 401 would confirm it
    // does and invite guessing.
    assert.deepEqual(checkAdminAuth(null, undefined), { ok: false, status: 404, message: "Not found" });
    assert.deepEqual(checkAdminAuth(`Bearer ${TOKEN}`, undefined), {
      ok: false,
      status: 404,
      message: "Not found"
    });
    assert.deepEqual(checkAdminAuth("Bearer anything", ""), { ok: false, status: 404, message: "Not found" });
  });

  it("accepts the correct bearer token", () => {
    assert.deepEqual(checkAdminAuth(`Bearer ${TOKEN}`, TOKEN), { ok: true });
  });

  it("rejects a missing, malformed or wrong token", () => {
    for (const header of [
      null,
      "",
      TOKEN, // no "Bearer " prefix
      `Bearer ${TOKEN}x`, // too long
      `Bearer ${TOKEN.slice(0, -1)}`, // too short
      `Bearer ${TOKEN.slice(0, -1)}X`, // right length, wrong bytes
      `Basic ${TOKEN}`
    ]) {
      const result = checkAdminAuth(header, TOKEN);
      assert.equal(result.ok, false, `should reject: ${JSON.stringify(header)}`);
      if (!result.ok) assert.equal(result.status, 401);
    }
  });

  it("does not throw on a length mismatch", () => {
    // timingSafeEqual throws when buffers differ in length; the length
    // check has to come first or a short token 500s instead of 401ing.
    assert.doesNotThrow(() => checkAdminAuth("Bearer x", TOKEN));
    assert.equal(checkAdminAuth("Bearer x", TOKEN).ok, false);
  });
});
