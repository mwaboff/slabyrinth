/**
 * JSON-reply protocol for models with weak or no native tool calling (architecture §3.11, toolMode "json").
 *
 * The provider appends `jsonProtocolSection(tools)` to the frozen system prompt at conversation start. The model
 * answers with one JSON object {"say": string, "calls": [{"tool": name, "input": {...}}]}; `parseJsonReply`
 * extracts it (tolerating code fences and prose around it) and validates every call with the SAME schemas the
 * native path uses. Tool results go back as a user message built by `jsonToolResultsText`.
 */
import { canonicalJson } from "../util/canonical";
import { validateToolInput, type ReportError } from "./inputs";
import { isToolName } from "./serialize";
import type { ToolDefinition, ToolName, ToolResultContent } from "./tools";

export function jsonProtocolSection(tools: readonly ToolDefinition[]): string {
  const lines = [
    "# Reply format",
    "",
    "Reply with exactly one JSON object and nothing else:",
    '{"say": "<what you tell the GM, may be empty>", "calls": [{"tool": "<tool name>", "input": {<tool input>}}]}',
    'Use "calls": [] when you only talk. Calls run in order. Tool results come back in a user message that starts with TOOL RESULTS; then reply again in the same format.',
    "",
    "# Tools",
  ];
  for (const t of tools) {
    lines.push("", `## ${t.name}`, t.description, `Input schema: ${canonicalJson(t.inputSchema)}`);
  }
  return lines.join("\n");
}

export interface JsonCall {
  tool: ToolName;
  input: unknown;
}

export type JsonReply =
  /** A well-formed protocol object whose calls all validated. */
  | { kind: "reply"; say: string; calls: JsonCall[] }
  /** No JSON object in the text: treat it as plain chat. */
  | { kind: "text"; say: string }
  /** JSON was found but is malformed or a call is invalid; `message` is what to send back for a corrected reply. */
  | { kind: "invalid"; message: string; errors: ReportError[] };

/** First balanced {...} in `text` (string-aware), preferring the content of a ```json fence. */
export function extractJsonObject(text: string): string | null {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  const sources = fence?.[1] !== undefined ? [fence[1], text] : [text];
  for (const src of sources) {
    const start = src.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    // Unbalanced: return the tail so the caller reports a parse error rather than "no JSON".
    return src.slice(start);
  }
  return null;
}

export function parseJsonReply(text: string, allowedTools?: readonly string[]): JsonReply {
  const json = extractJsonObject(text);
  if (json === null) return { kind: "text", say: text.trim() };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    const msg = `your reply was not valid JSON (${e instanceof Error ? e.message : "parse error"})`;
    return {
      kind: "invalid",
      message: `${msg}. Reply again with exactly one JSON object in the required format.`,
      errors: [{ code: "invalid_json", msg }],
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid([
      { code: "invalid_input", msg: 'the reply must be a JSON object with "say" and "calls"' },
    ]);
  }
  const obj = value as Record<string, unknown>;
  const say = typeof obj["say"] === "string" ? obj["say"] : "";
  const rawCalls = obj["calls"] ?? [];
  if (!Array.isArray(rawCalls))
    return invalid([{ code: "invalid_input", path: "/calls", msg: '"calls" must be an array' }]);
  const errors: ReportError[] = [];
  const calls: JsonCall[] = [];
  rawCalls.forEach((c: unknown, i) => {
    const call = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    const tool = call["tool"];
    if (
      typeof tool !== "string" ||
      !isToolName(tool) ||
      (allowedTools !== undefined && !allowedTools.includes(tool))
    ) {
      errors.push({
        code: "invalid_input",
        path: `/calls/${i}/tool`,
        msg: `unknown tool ${JSON.stringify(tool)}`,
        hint: `tools: ${(allowedTools ?? []).join(", ")}`,
      });
      return;
    }
    const input = call["input"] ?? {};
    const v = validateToolInput(tool, input);
    if (!v.ok) {
      for (const e of v.errors) errors.push({ ...e, path: `/calls/${i}/input${e.path ?? ""}` });
      return;
    }
    calls.push({ tool, input });
  });
  if (errors.length > 0) return invalid(errors);
  return { kind: "reply", say, calls };
}

function invalid(errors: ReportError[]): JsonReply {
  return {
    kind: "invalid",
    message: `Your reply could not be used: ${JSON.stringify(errors.slice(0, 20))}. Nothing was run. Reply again with one corrected JSON object.`,
    errors,
  };
}

/** The user-message text that carries tool results back in JSON mode. Images are described, not embedded. */
export function jsonToolResultsText(
  results: ReadonlyArray<{
    callId: string;
    name: string;
    isError: boolean;
    content: readonly ToolResultContent[];
  }>,
): string {
  const parts = ["TOOL RESULTS"];
  for (const r of results) {
    parts.push(`## ${r.name} (${r.callId}) ${r.isError ? "ERROR" : "OK"}`);
    for (const c of r.content)
      parts.push(c.type === "text" ? c.text : "[image omitted: this model does not read images]");
  }
  return parts.join("\n");
}
