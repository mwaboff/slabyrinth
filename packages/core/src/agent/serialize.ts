/**
 * Deterministic serialization of the tool list. The serialized bytes are part of the prompt-cache key and of the
 * prefix that preserved thinking is bound to, so they must never change within a conversation: schemas are
 * rendered with sorted keys (canonical JSON) and the tool order is the contract order.
 */
import { canonicalJson } from "../util/canonical";
import { TOOLS_1_7_0 } from "./tools.frozen";
import { TOOLS_1_8_0 } from "./tools.frozen.v1_8_0";
import { TOOLS_1_9_0 } from "./tools.frozen.v1_9_0";
import { TOOLS_1_10_0 } from "./tools.frozen.v1_10_0";
import { TOOL_DEFINITIONS, type JsonSchema, type ToolDefinition, type ToolName } from "./tools";

/** Published tool lists by version (tools.frozen*.ts). A version not listed here uses the working list. */
const FROZEN_TOOLS: Readonly<Record<string, readonly ToolDefinition[]>> = {
  "tools-1.7.0": TOOLS_1_7_0,
  "tools-1.8.0": TOOLS_1_8_0,
  "tools-1.9.0": TOOLS_1_9_0,
  "tools-1.10.0": TOOLS_1_10_0,
};

/** The tools whose results are pictures: offered only to a conversation on a model with image input. */
const PICTURE_TOOLS: ReadonlySet<string> = new Set<ToolName>(["view_map_image", "view_build_3d"]);

/**
 * The frozen tool list for a conversation. The picture tools (`view_map_image`, and `view_build_3d` from
 * tools-1.11.0) are offered only when the conversation started on a model with image input (architecture §3.3
 * item 4); the decision is frozen with the conversation. A conversation on a published tools version
 * (`toolsVersion`) gets that version's frozen definitions; otherwise (new conversations, versions before
 * tools-1.7.0) the working TOOL_DEFINITIONS.
 */
export function toolsForConversation(imageToolEnabled: boolean, toolsVersion?: string): ToolDefinition[] {
  const defs = (toolsVersion !== undefined ? FROZEN_TOOLS[toolsVersion] : undefined) ?? TOOL_DEFINITIONS;
  return defs
    .filter((t) => imageToolEnabled || !PICTURE_TOOLS.has(t.name))
    .map((t) => ({
      ...t,
      inputSchema: canonicalSchema(t.inputSchema),
    }));
}

/**
 * Whether a conversation's frozen tool list offers `name` (a conversation on a released tools version never sees a
 * tool added later, and the app never acts as if it had one).
 */
export function conversationHasTool(
  name: ToolName,
  imageToolEnabled: boolean,
  toolsVersion?: string,
): boolean {
  return toolsForConversation(imageToolEnabled, toolsVersion).some((t) => t.name === name);
}

/** A deep copy of `schema` whose object keys are in canonical (sorted) order. */
export function canonicalSchema(schema: JsonSchema): JsonSchema {
  return JSON.parse(canonicalJson(schema)) as JsonSchema;
}

/** The exact bytes of the neutral tool list (name, description, schema), used for snapshots and cache checks. */
export function serializeTools(tools: readonly ToolDefinition[]): string {
  return tools
    .map((t) => canonicalJson({ name: t.name, description: t.description, input_schema: t.inputSchema }))
    .join("\n");
}

export function isToolName(name: string): name is ToolName {
  return TOOL_DEFINITIONS.some((t) => t.name === name);
}
