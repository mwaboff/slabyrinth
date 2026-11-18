/**
 * Neutral transcript → Anthropic Messages request (architecture §3.10 "Rendering the neutral transcript").
 *
 * Rendering is a pure, deterministic function of (transcript, options): the same transcript always produces the
 * same bytes, which keeps the prompt cache warm and the prefix that preserved thinking is bound to unchanged.
 * Nothing earlier is ever rewritten:
 *  - assistant turns produced by Anthropic are replayed from `providerState.raw` VERBATIM (thinking signatures,
 *    fallback and compaction blocks) — thinking is never stripped on a model switch; the API drops what the new
 *    model can't read. The only omissions are the ones the refusal-fallback replay rule requires (blocks before
 *    the final `fallback` block that the fallback model did not produce) and the one-time strip-and-retry recovery;
 *  - app context → mid-conversation {role:"system"} messages (merged when adjacent), right after the user turn;
 *  - selection markers → effort-only system messages when per-message effort is in use, else nothing;
 *  - consecutive user-role entries (tool_results then user) merge into one message, tool results first.
 */
import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaSystemMessageParam,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { jsonProtocolSection, jsonToolResultsText } from "@slabyrinth/core/agent";
import type { MapSelection } from "@slabyrinth/core/contracts/resolved";
import type { ToolDefinition } from "@slabyrinth/core/agent/tools";
import type { ChatItem, EffortLevel, StepRequest } from "../types";
import { headerOf, type BetaFeature, type BetaFlags } from "./betas";
import type { AnthropicModelSpec } from "./models";

export interface RenderOptions {
  modelId: string;
  /** Use effort-only system messages for markers (flag on and the model supports it). */
  perMessageEffort: boolean;
  /** The model accepts mid-conversation {role:"system"} messages; otherwise context renders as tagged user text. */
  systemMessages: boolean;
  toolMode: StepRequest["toolMode"];
  /** One-time recovery after a "bound to a different conversation" 400: drop every thinking block. */
  stripThinking?: boolean;
}

type UserBlock = BetaContentBlockParam;

/** `<selection level="l1" areas="hall(#2)" features="abbot" rect="18,6 4x4"/>` (§3.5). Keys only; names live in the outline. */
export function selectionTag(s: MapSelection): string {
  const attrs = [`level="${s.levelId}"`];
  if (s.areaIds.length > 0) attrs.push(`areas="${s.areaIds.join(",")}"`);
  if (s.featureIds.length > 0) attrs.push(`features="${s.featureIds.join(",")}"`);
  if (s.openingIds.length > 0) attrs.push(`openings="${s.openingIds.join(",")}"`);
  if (s.linkIds.length > 0) attrs.push(`links="${s.linkIds.join(",")}"`);
  if (s.rect) attrs.push(`rect="${s.rect.x},${s.rect.y} ${s.rect.w}x${s.rect.h}"`);
  return `<selection ${attrs.join(" ")}/>`;
}

/** Anthropic tool_use ids must match ^[a-zA-Z0-9_-]+$; ids from other providers are mapped deterministically. */
export function safeToolId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return s.length > 0 ? s : "call";
}

/**
 * Applies the refusal-fallback replay rule to a stored assistant turn: before the FINAL `fallback` block, omit
 * thinking, redacted_thinking, tool_use, server_tool_use without its result, and unknown block types; keep text,
 * paired server-tool blocks and the fallback block in place. Everything after it is kept unchanged.
 */
export function replayableContent(raw: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  let last = -1;
  raw.forEach((b, i) => {
    if (b["type"] === "fallback") last = i;
  });
  if (last < 0) return [...raw];
  const resultIds = new Set(
    raw
      .slice(0, last)
      .filter((b) => typeof b["type"] === "string" && b["type"].endsWith("_tool_result"))
      .map((b) => b["tool_use_id"]),
  );
  const keep = (b: Record<string, unknown>): boolean => {
    const t = b["type"];
    if (t === "text" || t === "fallback") return true;
    if (t === "server_tool_use") return resultIds.has(b["id"]);
    return typeof t === "string" && t.endsWith("_tool_result");
  };
  return [...raw.slice(0, last).filter(keep), ...raw.slice(last)];
}

/** Tool calls in a stored Anthropic turn that the API will see (and that therefore need a tool_result). */
export function liveToolUseIds(raw: readonly Record<string, unknown>[]): string[] {
  return replayableContent(raw)
    .filter((b) => b["type"] === "tool_use" && typeof b["id"] === "string")
    .map((b) => b["id"] as string);
}

function asBlocks(raw: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null);
}

function imageBlock(mediaType: string, data: string): BetaImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType as "image/png" | "image/jpeg" | "image/webp", data },
  };
}

function toolResultBlocks(item: Extract<ChatItem, { type: "tool_results" }>, json: boolean): UserBlock[] {
  if (json) return [{ type: "text", text: jsonToolResultsText(item.results) }];
  return item.results.map((r): BetaToolResultBlockParam => {
    const content: Array<BetaTextBlockParam | BetaImageBlockParam> = r.content.map((c) =>
      c.type === "text"
        ? { type: "text", text: c.text.length > 0 ? c.text : "(empty)" }
        : imageBlock(c.mediaType, c.dataBase64),
    );
    const block: BetaToolResultBlockParam = { type: "tool_result", tool_use_id: safeToolId(r.callId) };
    if (content.length > 0) block.content = content;
    else block.content = "(no output)";
    if (r.isError) block.is_error = true;
    return block;
  });
}

function assistantContent(
  item: Extract<ChatItem, { type: "assistant" }>,
  opts: RenderOptions,
): BetaContentBlockParam[] {
  const raw = item.providerState?.providerId === "anthropic" ? asBlocks(item.providerState.raw) : null;
  if (raw !== null) {
    let blocks = replayableContent(raw);
    if (opts.stripThinking === true)
      blocks = blocks.filter((b) => b["type"] !== "thinking" && b["type"] !== "redacted_thinking");
    return blocks as unknown as BetaContentBlockParam[];
  }
  // Another provider (or no state): rebuild from neutral parts; reasoning is not portable and is dropped.
  const out: BetaContentBlockParam[] = [];
  for (const p of item.parts) {
    if (p.type === "text" && p.text.length > 0) out.push({ type: "text", text: p.text });
    else if (p.type === "tool_call") {
      if (opts.toolMode === "json")
        out.push({ type: "text", text: JSON.stringify({ calls: [{ tool: p.name, input: p.input }] }) });
      else
        out.push({
          type: "tool_use",
          id: safeToolId(p.callId),
          name: p.name,
          input: p.input as Record<string, unknown>,
        });
    }
  }
  return out.length > 0 ? out : [{ type: "text", text: "(no reply)" }];
}

type Entry =
  | { role: "user"; content: UserBlock[] }
  | { role: "assistant"; content: BetaContentBlockParam[] }
  | { role: "system"; texts: string[]; effort: EffortLevel | null };

/** Renders the neutral transcript as API messages. Pure and deterministic. */
export function renderMessages(transcript: readonly ChatItem[], opts: RenderOptions): BetaMessageParam[] {
  const json = opts.toolMode === "json";
  const entries: Entry[] = [];
  const last = (): Entry | undefined => entries[entries.length - 1];
  const pushUser = (blocks: UserBlock[]): void => {
    const prev = last();
    if (prev?.role === "user") prev.content.push(...blocks);
    else entries.push({ role: "user", content: blocks });
  };
  /**
   * App context and effort markers are held back and placed at the next LEGAL slot: right after a complete user
   * message (after the tool_results and text it merges), never directly after an assistant message and never
   * between a tool_use and its tool_result. That keeps every request valid even for a transcript that recorded a
   * marker while a question card was pending, or a selection change right after a reply.
   */
  let pending: { contexts: Array<{ reason: string; text: string }>; effort: EffortLevel | null } = {
    contexts: [],
    effort: null,
  };
  const tagged = (c: { reason: string; text: string }): UserBlock => ({
    type: "text",
    text: `<app_context reason="${c.reason}">
${c.text}
</app_context>`,
  });
  const flush = (): void => {
    const { contexts, effort } = pending;
    pending = { contexts: [], effort: null };
    if (contexts.length === 0 && effort === null) return;
    if (last()?.role === "user" && opts.systemMessages) {
      entries.push({ role: "system", texts: contexts.map((c) => c.text), effort });
      return;
    }
    // No legal system slot (or no system messages on this model): context goes into the user turn as tagged
    // text; an effort change without a slot is dropped (top-level effort applies).
    if (contexts.length > 0) pushUser(contexts.map(tagged));
  };

  for (const item of transcript) {
    switch (item.type) {
      case "user": {
        const blocks: UserBlock[] = [];
        if (item.selection) blocks.push({ type: "text", text: selectionTag(item.selection) });
        for (const img of item.images ?? [])
          if (img.dataBase64) blocks.push(imageBlock(img.mediaType, img.dataBase64));
        blocks.push({ type: "text", text: item.text.length > 0 ? item.text : "(no text)" });
        pushUser(blocks);
        break;
      }
      case "context":
        pending.contexts.push({ reason: item.reason, text: item.text });
        break;
      case "marker": {
        if (
          opts.perMessageEffort &&
          item.selection.modelId === opts.modelId &&
          item.selection.effort !== null
        ) {
          pending.effort = item.selection.effort;
        }
        break;
      }
      case "assistant": {
        if (item.excludedFromContext === true) break;
        flush();
        entries.push({ role: "assistant", content: assistantContent(item, opts) });
        break;
      }
      case "tool_results":
        pushUser(toolResultBlocks(item, json));
        break;
    }
  }

  flush();

  const out: BetaMessageParam[] = [];
  for (const e of entries) {
    if (e.role === "system") {
      const m: BetaSystemMessageParam = {
        role: "system",
        content: e.texts.map((t): BetaTextBlockParam => ({ type: "text", text: t })),
      };
      if (e.effort !== null) m.output_config = { effort: e.effort };
      out.push(m);
    } else out.push({ role: e.role, content: e.content });
  }
  return out;
}

export function renderTools(tools: readonly ToolDefinition[]): BetaTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
}

export interface BuildOptions {
  spec: AnthropicModelSpec | undefined;
  flags: BetaFlags;
  /** Effort control is available on this model (descriptor). */
  effortSupported: boolean;
  cacheTtl: "5m" | "1h";
  bindingBehavior: "drop_block" | "error";
  stripThinking?: boolean;
}

export interface BuiltRequest {
  params: BetaMessageStreamParams;
  /** Beta features this request uses (for blaming a 400). */
  features: BetaFeature[];
}

/** The full request for one step (§3.10 "Request shape per step"). */
export function buildRequest(req: StepRequest, o: BuildOptions): BuiltRequest {
  const spec = o.spec;
  const features: BetaFeature[] = [];
  const use = (f: BetaFeature, applies: boolean): boolean => {
    const on = applies && o.flags.enabled(f);
    if (on) features.push(f);
    return on;
  };
  const fallbacks = use("fallbacks", spec?.fallbacks === true);
  const binding = use("bindingControls", true);
  const compaction = use("compaction", true);
  const perMessageEffort = use("perMessageEffort", spec?.perMessageEffort === true && o.effortSupported);

  const json = req.toolMode === "json";
  const systemText = json ? `${req.systemPrompt}\n\n${jsonProtocolSection(req.tools)}` : req.systemPrompt;
  const renderOpts: RenderOptions = {
    modelId: req.selection.modelId,
    perMessageEffort,
    systemMessages: spec?.systemMessages === true,
    toolMode: req.toolMode,
  };
  if (o.stripThinking === true) renderOpts.stripThinking = true;
  const messages = renderMessages(req.transcript, renderOpts);

  const params: BetaMessageStreamParams = {
    model: req.selection.modelId,
    max_tokens: Math.min(req.maxOutputTokens, spec?.maxOutputTokens ?? req.maxOutputTokens),
    thinking: binding
      ? {
          type: "adaptive",
          display: "summarized",
          block_binding: { prefix_mismatch_behavior: o.bindingBehavior },
        }
      : { type: "adaptive", display: "summarized" },
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral", ttl: "1h" } }],
    cache_control: { type: "ephemeral", ttl: o.cacheTtl },
    messages,
  };
  if (req.toolMode === "native") params.tools = renderTools(req.tools);
  if (fallbacks) params.fallbacks = "default";
  if (compaction) params.context_management = { edits: [{ type: "compact_20260112" }] };
  if (!perMessageEffort && o.effortSupported && req.effort !== null)
    params.output_config = { effort: req.effort };
  if (features.length > 0) params.betas = features.map(headerOf);
  return { params, features };
}
