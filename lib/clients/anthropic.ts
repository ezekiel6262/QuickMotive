import Anthropic from "@anthropic-ai/sdk";

let cached: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  cached = new Anthropic({ apiKey });
  return cached;
}

export const ORCHESTRATOR_MODEL = process.env.ANTHROPIC_ORCHESTRATOR_MODEL ?? "claude-sonnet-5";

export interface StructuredPromptFields {
  subject: string;
  style: string;
  lighting: string;
  composition: string;
  camera_or_motion_notes: string;
}

const PROMPT_EXTRACTION_TOOL = {
  name: "record_prompt_fields",
  description: "Record the structured prompt fields extracted from the media.",
  input_schema: {
    type: "object" as const,
    properties: {
      subject: { type: "string" },
      style: { type: "string" },
      lighting: { type: "string" },
      composition: { type: "string" },
      camera_or_motion_notes: { type: "string" }
    },
    required: ["subject", "style", "lighting", "composition", "camera_or_motion_notes"]
  }
};

/** S1 media -> prompt: describe an image into fields reusable by another generator. */
export async function extractStructuredPrompt(imageUrl: string): Promise<StructuredPromptFields> {
  const client = getAnthropicClient();
  const message = await client.messages.create({
    model: ORCHESTRATOR_MODEL,
    max_tokens: 1024,
    tools: [PROMPT_EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "record_prompt_fields" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          {
            type: "text",
            text: "Analyze this image and record structured prompt fields (subject, style, lighting, composition, camera/motion notes) that could be reused verbatim as an input prompt to another image or video generator."
          }
        ]
      }
    ]
  });

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Model did not return structured prompt fields");
  }
  return toolUse.input as StructuredPromptFields;
}

const EDIT_PLAN_TOOL = {
  name: "record_edit_operations",
  description: "Record the Canva edit operations that implement the buyer's plain-language instruction.",
  input_schema: {
    type: "object" as const,
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["replace_text", "find_and_replace_text", "recolor_element", "resize_element", "position_element", "update_fill"]
            },
            element_id: { type: "string" },
            text: { type: "string" },
            find_text: { type: "string" },
            replace_text: { type: "string" },
            color: { type: "string" },
            width: { type: "number" },
            height: { type: "number" },
            top: { type: "number" },
            left: { type: "number" }
          },
          required: ["type", "element_id"]
        }
      }
    },
    required: ["operations"]
  }
};

/** S3: turns a plain-language design instruction into a bounded set of Canva edit operations. */
export async function planEditOperations(params: {
  instruction: string;
  elements: Array<{ id: string; type: string }>;
}): Promise<Array<Record<string, unknown>>> {
  const client = getAnthropicClient();
  const message = await client.messages.create({
    model: ORCHESTRATOR_MODEL,
    max_tokens: 1024,
    tools: [EDIT_PLAN_TOOL],
    tool_choice: { type: "tool", name: "record_edit_operations" },
    messages: [
      {
        role: "user",
        content: `Design elements: ${JSON.stringify(params.elements)}\n\nInstruction: "${params.instruction}"\n\nMap this instruction onto the smallest set of edit operations against the element IDs above.`
      }
    ]
  });

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Model did not return an edit plan");
  }
  return (toolUse.input as { operations: Array<Record<string, unknown>> }).operations;
}

const TAXONOMY_TOOL = {
  name: "record_trait_taxonomy",
  description: "Record a layered NFT trait taxonomy (categories and their discrete options).",
  input_schema: {
    type: "object" as const,
    properties: {
      categories: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string" },
            options: { type: "array", items: { type: "string" } }
          },
          required: ["category", "options"]
        }
      }
    },
    required: ["categories"]
  }
};

/**
 * S10 step 1 fallback: when the buyer supplies a source image instead of an
 * explicit taxonomy, propose one from the image. This is a description-based
 * approximation of true segmentation -- see README "Known integration gaps".
 */
export async function proposeTraitTaxonomy(imageUrl: string): Promise<Array<{ category: string; options: string[] }>> {
  const client = getAnthropicClient();
  const message = await client.messages.create({
    model: ORCHESTRATOR_MODEL,
    max_tokens: 1024,
    tools: [TAXONOMY_TOOL],
    tool_choice: { type: "tool", name: "record_trait_taxonomy" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          {
            type: "text",
            text: "Decompose this character/asset into a layered NFT trait taxonomy (e.g. background, body, eyes, accessories). For each category propose 3-6 plausible option names a generator could produce as separate transparent-background layers."
          }
        ]
      }
    ]
  });

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Model did not return a trait taxonomy");
  }
  return (toolUse.input as { categories: Array<{ category: string; options: string[] }> }).categories;
}
