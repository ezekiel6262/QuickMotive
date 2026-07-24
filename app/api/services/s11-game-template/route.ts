import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError, ApiError } from "@/lib/api-helpers";
import { withJob } from "@/lib/jobs";
import * as higgsfield from "@/lib/clients/higgsfield";
import { getToolDefinition } from "@/lib/a2mcp/registry";

const bodySchema = z.object({
  buyer_wallet: z.string().optional(),
  template: z.enum(["endless_runner", "platformer", "match_3"]),
  character_asset_url: z.string().url(),
  title: z.string().min(1)
});

/**
 * S11: Simple templated game from a single character/design. Deliberately
 * scoped to 3 fixed templates rather than open-ended "any game from any
 * prompt" -- see build brief.
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet);
    const pricing = getToolDefinition("s11_game_template")!.pricing;

    const { job_id, output } = await withJob(
      { serviceType: "s11_game_template", buyerWallet, input: body },
      async () => {
        const instructions = await higgsfield.getGameCreationInstructions();
        const matchedTemplate = instructions.templates.find((t) => t.id === body.template);
        if (!matchedTemplate) {
          throw new ApiError(
            502,
            `Higgsfield does not currently offer a "${body.template}" template (available: ${instructions.templates.map((t) => t.id).join(", ")})`
          );
        }

        const deployed = await higgsfield.deployGame({
          templateId: matchedTemplate.id,
          characterAssetUrl: body.character_asset_url,
          title: body.title
        });
        const published = await higgsfield.publishGame({ deployId: deployed.deploy_id });

        return { play_url: published.play_url };
      }
    );

    return NextResponse.json({ job_id, price: pricing, ...output });
  } catch (err) {
    return handleRouteError(err);
  }
}
