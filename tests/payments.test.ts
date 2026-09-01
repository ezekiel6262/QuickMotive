import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { toAtomicUnits, BSC_MAINNET_TOKENS } from "../lib/chains/bnb";
import { priceForRequest, shortfallCredit } from "../lib/payments/x402";
import { VEO_DEFAULT_DURATION_SECONDS, VEO_PRICE_PER_SECOND, PROVIDER_UNIT_COSTS } from "../lib/pricing/costs";

/**
 * The money arithmetic, tested directly. Everything here decides how much a
 * buyer is charged or credited, and all of it is pure -- no database, no
 * facilitator, no chain -- so there is no excuse for it to be untested.
 */

describe("toAtomicUnits", () => {
  it("does not lose precision on prices that break floating point", () => {
    // 0.35 * 1e18 in floating point is 349999999999999994 -- a facilitator
    // would settle a different amount than the one advertised.
    assert.equal(toAtomicUnits(0.35, 18), "350000000000000000");
    assert.equal(toAtomicUnits(0.1, 18), "100000000000000000");
    assert.equal(toAtomicUnits(2.99, 18), "2990000000000000000");
  });

  it("handles whole numbers and zero", () => {
    assert.equal(toAtomicUnits(3, 18), "3000000000000000000");
    assert.equal(toAtomicUnits(1, 6), "1000000");
    assert.equal(toAtomicUnits(0, 18), "0");
  });

  it("scales with the token's own decimals", () => {
    // The BSC-vs-Ethereum trap: the same $1 is a different integer.
    assert.equal(toAtomicUnits(1, 18), "1000000000000000000");
    assert.equal(toAtomicUnits(1, 6), "1000000");
  });

  it("rejects negative amounts rather than encoding nonsense", () => {
    assert.throws(() => toAtomicUnits(-1, 18));
  });
});

describe("BSC token table", () => {
  it("keeps 18 decimals for BEP-20 stablecoins", () => {
    // A 6 here (copied from an Ethereum/Base config) misprices by 10^12.
    for (const [symbol, token] of Object.entries(BSC_MAINNET_TOKENS)) {
      assert.equal(token.decimals, 18, `${symbol} should be 18-decimal on BSC`);
      assert.match(token.address, /^0x[0-9a-fA-F]{40}$/, `${symbol} needs a valid address`);
    }
  });
});

describe("priceForRequest", () => {
  it("ignores quantity for per_call pricing", () => {
    assert.equal(priceForRequest("s5_brand_kit", 1).amount, 0.1);
    assert.equal(priceForRequest("s5_brand_kit", 50).amount, 0.1);
  });

  it("scales per-asset pricing by the requested count", () => {
    assert.equal(priceForRequest("s6_nft_image_gen", 10).amount, 3);
    assert.equal(priceForRequest("s8_batch_generation", 4).amount, 1.4);
  });

  it("prices video by the second", () => {
    assert.equal(priceForRequest("s2_image_to_motion", 8).amount, Number((VEO_PRICE_PER_SECOND * 8).toFixed(6)));
  });
});

describe("video pricing covers Veo", () => {
  it("charges more per second than Veo costs per second", () => {
    // The original bug: a flat $0.40/call against a clip costing up to
    // $1.20. Every allowed duration must now clear its own cost.
    for (const seconds of [4, 6, 8]) {
      const price = priceForRequest("s2_image_to_motion", seconds).amount;
      const cost = PROVIDER_UNIT_COSTS.veo_fast_per_second * seconds;
      assert.ok(price > cost, `${seconds}s: priced ${price}, costs ${cost}`);
    }
  });

  it("prices S1's video path above S1's flat price", () => {
    const videoPath = priceForRequest("s2_image_to_motion", VEO_DEFAULT_DURATION_SECONDS).amount;
    const flat = priceForRequest("s1_prompt_bridge").amount;
    assert.ok(videoPath > flat, "S1 video must not be sold at the flat prompt-bridge price");
  });
});

describe("shortfallCredit", () => {
  it("credits nothing when everything requested was delivered", () => {
    assert.equal(shortfallCredit("s8_batch_generation", 10, 10), 0);
  });

  it("credits nothing when more was delivered than charged for", () => {
    assert.equal(shortfallCredit("s8_batch_generation", 10, 12), 0);
  });

  it("credits the difference when QC flags some assets", () => {
    // 10 requested at 0.35 = 3.50 charged; 7 passed = 2.45 owed.
    assert.equal(shortfallCredit("s8_batch_generation", 10, 7), 1.05);
  });

  it("credits the difference when dedup rejects tokens", () => {
    // 100 requested at 0.50 = 50.00 charged; 92 issued = 46.00 owed.
    assert.equal(shortfallCredit("s10_trait_engine", 100, 92), 4);
  });

  it("credits the whole charge when nothing was delivered", () => {
    // The case a naive `price(delivered)` gets wrong: priceForRequest
    // floors quantity at 1, so a zero-delivery job would otherwise keep
    // one unit's worth of the buyer's money.
    assert.equal(shortfallCredit("s6_nft_image_gen", 5, 0), 1.5);
    assert.equal(shortfallCredit("s6_nft_image_gen", 5, 0), priceForRequest("s6_nft_image_gen", 5).amount);
  });

  it("credits a short video by the second", () => {
    // Charged for 8s, Veo returned 4s.
    assert.equal(
      shortfallCredit("s2_image_to_motion", 8, 4),
      Number((VEO_PRICE_PER_SECOND * 4).toFixed(6))
    );
  });

  it("never credits on per_call pricing", () => {
    assert.equal(shortfallCredit("s4_nft_scanner_report", 1, 0), 0);
    assert.equal(shortfallCredit("s11_game_template", 1, 0), 0);
  });

  it("treats negative delivery as zero rather than crediting extra", () => {
    assert.equal(shortfallCredit("s6_nft_image_gen", 5, -3), priceForRequest("s6_nft_image_gen", 5).amount);
  });
});
