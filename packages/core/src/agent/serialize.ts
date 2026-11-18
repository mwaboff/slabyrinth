/**
 * Deterministic serialization of the tool list. The serialized bytes are part of the prompt-cache key and of the
 * prefix that preserved thinking is bound to, so they must never change within a conversation: schemas are
 * rendered with sorted keys (canonical JSON) and the tool order is the contract order.
 */
import { canonicalJson } from "../util/canonical";
import { TOOL_DEFINITIONS, type JsonSchema, type ToolDefinition, type ToolName } from "./tools";

/**
 * The frozen tool list for a conversation. `view_map_image` is offered only when the conversation started on a
 * model with image input (architecture §3.3 item 4); the decision is frozen with the conversation.
 */
export function toolsForConversation(imageToolEnabled: boolean): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => imageToolEnabled || t.name !== "view_map_image").map((t) => ({
    ...t,
    inputSchema: canonicalSchema(t.inputSchema),
  }));
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
