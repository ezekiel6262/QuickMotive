/**
 * Assert no service is sold below what it costs to run.
 *
 *   npm run verify:pricing
 *
 * S2 shipped at a flat $0.40/call against a Veo clip costing up to $1.20.
 * That survived because nothing checked. This is the check: any registry
 * entry with a known provider cost must price above it, and the whole table
 * is printed so a human can see what buyers are quoted.
 *
 * Needs no network and no credentials, so it belongs in CI next to
 * typecheck and lint.
 */

import { A2MCP_TOOL_REGISTRY } from "../lib/a2mcp/registry";
import { PRICE_MARGIN, VEO_DEFAULT_DURATION_SECONDS, VEO_PRICE_PER_SECOND } from "../lib/pricing/costs";

/** Below this, a price is technically above cost but not viably so. */
const MIN_ACCEPTABLE_MARGIN = 0.2;

const failures: string[] = [];
const warnings: string[] = [];

console.log(`price margin: ${(PRICE_MARGIN * 100).toFixed(0)}% over worst-case provider cost\n`);
console.log("service                     unit                  price     cost   margin");
console.log("-".repeat(76));

for (const tool of A2MCP_TOOL_REGISTRY) {
  const { unit, amount, currency } = tool.pricing;
  const cost = tool.costBasis?.unitCost;

  let costCell = "     -";
  let marginCell = "       -";

  if (cost !== undefined) {
    costCell = cost.toFixed(3).padStart(6);
    if (amount <= cost) {
      failures.push(
        `${tool.id}: priced at ${amount} ${currency} per ${unit.replace(/_/g, " ")}, ` +
          `but ${tool.costBasis!.provider} costs ${cost} per the same unit -- every call loses money.`
      );
      marginCell = "   LOSS!";
    } else {
      const margin = (amount - cost) / cost;
      marginCell = `${(margin * 100).toFixed(0)}%`.padStart(8);
      if (margin < MIN_ACCEPTABLE_MARGIN) {
        warnings.push(
          `${tool.id}: only ${(margin * 100).toFixed(0)}% over provider cost -- storage, ` +
            `egress and failed generations are not covered by that.`
        );
      }
    }
  }

  console.log(
    `${tool.id.padEnd(26)}  ${unit.padEnd(20)}  ${amount.toFixed(3).padStart(6)}  ${costCell}  ${marginCell}`
  );
}

// S1 is the one entry whose headline price deliberately does not cover all
// of its paths: `output_type: "video"` runs Veo and is billed at S2's rate
// instead (see the route's `priceAs`). Assert that redirect is still worth
// making, so nobody "simplifies" it away.
const s1 = A2MCP_TOOL_REGISTRY.find((t) => t.id === "s1_prompt_bridge");
const videoPathPrice = VEO_PRICE_PER_SECOND * VEO_DEFAULT_DURATION_SECONDS;
if (s1 && s1.pricing.amount >= videoPathPrice) {
  warnings.push(
    `s1_prompt_bridge's flat price (${s1.pricing.amount}) now covers its ${VEO_DEFAULT_DURATION_SECONDS}s ` +
      `video path (${videoPathPrice.toFixed(2)}); the priceAs redirect in its route is redundant.`
  );
} else {
  console.log(
    `\ns1_prompt_bridge video path bills at the video rate: ` +
      `${VEO_DEFAULT_DURATION_SECONDS}s x ${VEO_PRICE_PER_SECOND} = ${videoPathPrice.toFixed(2)} ` +
      `(vs its ${s1?.pricing.amount} flat price)`
  );
}

console.log();
for (const w of warnings) console.log(`WARN  ${w}`);
for (const f of failures) console.log(`FAIL  ${f}`);

if (failures.length > 0) {
  console.log(`\n${failures.length} service(s) priced below cost.`);
  process.exit(1);
}
console.log(`\nAll priced services cover their known provider costs.`);
