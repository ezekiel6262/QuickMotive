import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireBuyerWallet, handleRouteError } from "@/lib/api-helpers";
import { withJob } from "@/lib/jobs";
import { buildGame } from "@/lib/games/build-game";
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
 * prompt" -- see build brief. Self-hosted: each template is a
 * self-contained HTML5/Canvas page (lib/games/templates/) skinned with the
 * buyer's character art and uploaded to Supabase Storage as a single
 * static file. No third-party game-hosting API.
 */
export async function POST(req: Request) {
  try {
    const body = await parseBody<z.infer<typeof bodySchema>>(req, bodySchema);
    const buyerWallet = requireBuyerWallet(req, body.buyer_wallet);
    const pricing = getToolDefinition("s11_game_template")!.pricing;

    const { job_id, output } = await withJob(
      { serviceType: "s11_game_template", buyerWallet, input: body },
      async () => {
        const { playUrl } = await buildGame({
          template: body.template,
          characterImageUrl: body.character_asset_url,
          title: body.title
        });

        return { play_url: playUrl };
      }
    );

    return NextResponse.json({ job_id, price: pricing, ...output });
  } catch (err) {
    return handleRouteError(err);
  }
}
