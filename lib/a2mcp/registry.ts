import type { A2mcpToolDefinition } from "./types";
import { PROVIDER_UNIT_COSTS, VEO_PRICE_PER_SECOND } from "@/lib/pricing/costs";

/**
 * Central A2MCP tool catalog for the OKX.ai Creative & NFT Agent Suite ASP.
 * Each entry maps 1:1 to a standalone API route so any single service can be
 * registered, priced, and tested independently -- see build brief section 5
 * (OKX.ai integration checklist).
 *
 * Prices are placeholders (`amount`) pending confirmation of Higgsfield's
 * per-call credit cost -- see README "Open risks".
 */
export const A2MCP_TOOL_REGISTRY: A2mcpToolDefinition[] = [
  {
    id: "s1_prompt_bridge",
    name: "Image/Video <-> Text Prompt Bridge",
    summary:
      "Given media, return a structured re-usable prompt. Given text, generate an image or video via Higgsfield.",
    route: "/api/services/s1-prompt-bridge",
    /**
     * Flat, but only for the prompt-extraction and image paths.
     * `output_type: "video"` routes to Veo, whose cost is ~24x this price,
     * so that path is billed at S2's per-second rate instead (see the
     * route). Left as the headline price because it is what the common
     * case costs.
     */
    pricing: {
      unit: "per_call",
      amount: 0.05,
      currency: "USDT",
      notes: `output_type "video" is billed at the video rate of ${VEO_PRICE_PER_SECOND}/second instead`
    },
    latencyExpectation: "sub-second to a few seconds",
    inputSchema: {
      type: "object",
      oneOf: [
        { required: ["media_url"], properties: { media_url: { type: "string", format: "uri" } } },
        { required: ["prompt"], properties: { prompt: { type: "string" } } }
      ],
      properties: {
        media_url: { type: "string", format: "uri" },
        prompt: { type: "string" },
        output_type: { type: "string", enum: ["image", "video"], default: "image" },
        brand_kit_id: { type: "string", format: "uuid" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["media_to_prompt", "text_to_media"] },
        prompt_fields: {
          type: "object",
          properties: {
            subject: { type: "string" },
            style: { type: "string" },
            lighting: { type: "string" },
            composition: { type: "string" },
            camera_or_motion_notes: { type: "string" }
          }
        },
        asset_url: { type: "string", format: "uri" }
      }
    }
  },
  {
    id: "s2_image_to_motion",
    name: "Video Motion From a Single Image",
    summary: "Animate a still image with optional motion description via Google Veo (Gemini API).",
    route: "/api/services/s2-image-to-motion",
    /**
     * Per-second, derived from Veo's per-second cost. The previous flat
     * $0.40/call was below cost at every allowed duration (4s costs ~$0.60,
     * 8s ~$1.20), so it lost money on every request -- fatal once the price
     * is collected on-chain rather than invoiced.
     */
    pricing: {
      unit: "per_second",
      amount: VEO_PRICE_PER_SECOND,
      currency: "USDT",
      notes: "billed per second of delivered video (4, 6 or 8s); a shorter clip than requested is credited back"
    },
    costBasis: { unitCost: PROVIDER_UNIT_COSTS.veo_fast_per_second, provider: "veo-3.1-fast" },
    latencyExpectation: "tens of seconds to ~2 minutes",
    inputSchema: {
      type: "object",
      required: ["image_url"],
      properties: {
        image_url: { type: "string", format: "uri" },
        motion_description: { type: "string" },
        max_duration_seconds: { type: "integer", enum: [4, 6, 8], default: 6 },
        resolution: { type: "string", enum: ["720p", "1080p"], default: "720p" }
      }
    },
    outputSchema: {
      type: "object",
      properties: { video_url: { type: "string", format: "uri" }, duration_seconds: { type: "number" } }
    }
  },
  {
    id: "s3_design_tweak",
    name: "Graphic Design Smart Edit",
    summary: "Apply a plain-language instruction to an existing Canva design (or a raster asset via outpaint/inpaint) and export the result.",
    route: "/api/services/s3-design-tweak",
    pricing: { unit: "per_call", amount: 0.15, currency: "USDT", notes: "buyer's design must already exist in Canva or be importable" },
    latencyExpectation: "a few seconds",
    inputSchema: {
      type: "object",
      required: ["instruction"],
      properties: {
        canva_design_id: { type: "string" },
        design_import_url: { type: "string", format: "uri" },
        raster_image_url: { type: "string", format: "uri" },
        instruction: { type: "string" }
      },
      oneOf: [
        { required: ["canva_design_id", "instruction"] },
        { required: ["design_import_url", "instruction"] },
        { required: ["raster_image_url", "instruction"] }
      ]
    },
    outputSchema: {
      type: "object",
      properties: {
        exported_file_url: { type: "string", format: "uri" },
        canva_design_url: { type: "string", format: "uri" }
      }
    }
  },
  {
    id: "s4_nft_scanner_report",
    name: "On-Chain NFT Collection Scanner + PDF Report",
    summary: "Enumerate a collection's tokens/traits, compute rarity, and render a cover+grid PDF plus structured JSON.",
    route: "/api/services/s4-nft-scanner-report",
    pricing: { unit: "per_call", amount: 2, currency: "USDT", notes: "large (10k+) collections may take longer due to Moralis/Covalent pagination" },
    latencyExpectation: "seconds to low minutes depending on collection size",
    inputSchema: {
      type: "object",
      required: ["contract_address", "chain"],
      properties: {
        contract_address: { type: "string" },
        chain: { type: "string", examples: ["eth", "polygon", "base"] },
        marketplace_url: { type: "string", format: "uri" },
        max_tokens: { type: "integer", default: 2000 }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        pdf_url: { type: "string", format: "uri" },
        json: {
          type: "object",
          properties: {
            collection_name: { type: "string" },
            token_count: { type: "integer" },
            tokens: { type: "array", items: { type: "object" } }
          }
        }
      }
    }
  },
  {
    id: "s5_brand_kit",
    name: "Brand-Lock Kit Definition",
    summary: "Persist a buyer's palette/typography/logo/style-reference/tone kit for reuse across every future generation call.",
    route: "/api/services/s5-brand-kit",
    pricing: { unit: "per_call", amount: 0.1, currency: "USDT", notes: "one-time setup call per kit create/update" },
    latencyExpectation: "sub-second",
    inputSchema: {
      type: "object",
      required: ["buyer_wallet", "name"],
      properties: {
        buyer_wallet: { type: "string" },
        brand_kit_id: { type: "string", format: "uuid", description: "omit to create, include to update" },
        name: { type: "string" },
        palette: { type: "array", items: { type: "object", properties: { hex: { type: "string" }, role: { type: "string" } } } },
        typography: { type: "object" },
        logo_urls: { type: "array", items: { type: "string", format: "uri" } },
        style_ref_urls: { type: "array", items: { type: "string", format: "uri" } },
        tone_descriptors: { type: "string" }
      }
    },
    outputSchema: {
      type: "object",
      properties: { brand_kit_id: { type: "string", format: "uuid" } }
    }
  },
  {
    id: "s6_nft_image_gen",
    name: "NFT Image Generation From Description",
    summary: "Generate a styled image set from a text description, optionally brand-locked and style-referenced. No dedup guarantee at this tier.",
    route: "/api/services/s6-nft-image-gen",
    pricing: { unit: "per_delivered_asset", amount: 0.3, currency: "USDT" },
    latencyExpectation: "seconds per asset, generated in parallel",
    inputSchema: {
      type: "object",
      required: ["description", "count"],
      properties: {
        description: { type: "string" },
        style_reference_url: { type: "string", format: "uri" },
        collection_theme: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 100 },
        brand_kit_id: { type: "string", format: "uuid" }
      }
    },
    outputSchema: {
      type: "object",
      properties: { assets: { type: "array", items: { type: "object", properties: { url: { type: "string" } } } } }
    }
  },
  {
    id: "s7_nft_variation",
    name: "NFT Variation From a Source Image",
    summary: "img2img remix of a source image into N variations with a per-image similarity score.",
    route: "/api/services/s7-nft-variation",
    pricing: { unit: "per_delivered_asset", amount: 0.3, currency: "USDT" },
    latencyExpectation: "seconds per asset, generated in parallel",
    inputSchema: {
      type: "object",
      required: ["source_image_url", "variation_count"],
      properties: {
        source_image_url: { type: "string", format: "uri" },
        variation_count: { type: "integer", minimum: 1, maximum: 50 },
        strength: { type: "number", minimum: 0, maximum: 1, default: 0.5 }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        variations: {
          type: "array",
          items: { type: "object", properties: { url: { type: "string" }, similarity_score: { type: "number" } } }
        }
      }
    }
  },
  {
    id: "s8_batch_generation",
    name: "Batch Generation With QC Gating",
    summary: "Fan out N brand-constrained generations in parallel, auto-flag failures, deliver passing set + flagged set with reasons.",
    route: "/api/services/s8-batch-generation",
    pricing: { unit: "per_delivered_asset", amount: 0.35, currency: "USDT", notes: "priced per PASSING asset; regenerate-once policy is explicit per request" },
    latencyExpectation: "seconds, bounded by the slowest single generation (parallel fan-out)",
    inputSchema: {
      type: "object",
      required: ["brief", "count"],
      properties: {
        brief: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 200 },
        brand_kit_id: { type: "string", format: "uuid" },
        target_aspect_ratio: { type: "string", default: "1:1" },
        regenerate_once_on_flag: { type: "boolean", default: true }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        passing: { type: "array", items: { type: "object" } },
        flagged: { type: "array", items: { type: "object", properties: { url: { type: "string" }, reasons: { type: "array", items: { type: "string" } } } } }
      }
    }
  },
  {
    id: "s9_export_bundle",
    name: "NFT-Ready Multi-Format Export",
    summary: "Package one source asset into marketplace-correct images, metadata JSON, and non-NFT crops/resolutions in a single call.",
    route: "/api/services/s9-export-bundle",
    pricing: { unit: "per_call", amount: 0.2, currency: "USDT" },
    latencyExpectation: "a few seconds",
    inputSchema: {
      type: "object",
      required: ["source_asset_url"],
      properties: {
        source_asset_url: { type: "string", format: "uri" },
        targets: {
          type: "array",
          items: { type: "string", enum: ["marketplace", "social", "print", "web"] },
          default: ["marketplace", "social", "web"]
        },
        marketplace: { type: "string", description: "defaults to most common specs if omitted" },
        nft_metadata: {
          type: "object",
          properties: { name: { type: "string" }, description: { type: "string" }, attributes: { type: "array" } }
        }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        manifest_url: { type: "string", format: "uri" },
        bundle: { type: "array", items: { type: "object", properties: { target: { type: "string" }, file_url: { type: "string" } } } }
      }
    }
  },
  {
    id: "s10_trait_engine",
    name: "Trait-Based Generative Art Engine",
    summary: "Decompose a brief/source into a trait taxonomy, generate a layered trait library, composite full collections, and hash-dedup issued combinations.",
    route: "/api/services/s10-trait-engine",
    pricing: { unit: "per_token", amount: 0.5, currency: "USDT", notes: "priced per issued (non-colliding) token" },
    latencyExpectation: "minutes for the trait library build, seconds per composited token thereafter",
    inputSchema: {
      type: "object",
      required: ["collection_id", "collection_size"],
      properties: {
        collection_id: { type: "string", format: "uuid" },
        source_image_url: { type: "string", format: "uri" },
        trait_categories: {
          type: "array",
          items: { type: "object", properties: { category: { type: "string" }, options: { type: "array", items: { type: "string" } } } }
        },
        collection_size: { type: "integer", minimum: 1, maximum: 10000 },
        brand_kit_id: { type: "string", format: "uuid" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        manifest_url: { type: "string", format: "uri" },
        preview_pdf_url: { type: "string", format: "uri" },
        tokens_issued: { type: "integer" },
        rejected_collisions: { type: "integer" }
      }
    }
  },
  {
    id: "s11_game_template",
    name: "Templated Game From a Character/Design",
    summary: "Skin one of a fixed set of templates (endless runner, platformer, match-3) with generated/uploaded character art and publish a playable URL.",
    route: "/api/services/s11-game-template",
    pricing: { unit: "per_call", amount: 3, currency: "USDT" },
    latencyExpectation: "low minutes",
    inputSchema: {
      type: "object",
      required: ["template", "character_asset_url", "title"],
      properties: {
        template: { type: "string", enum: ["endless_runner", "platformer", "match_3"] },
        character_asset_url: { type: "string", format: "uri" },
        title: { type: "string" }
      }
    },
    outputSchema: {
      type: "object",
      properties: { play_url: { type: "string", format: "uri" } }
    }
  }
];

export function getToolDefinition(id: string): A2mcpToolDefinition | undefined {
  return A2MCP_TOOL_REGISTRY.find((tool) => tool.id === id);
}
