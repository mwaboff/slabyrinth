/**
 * The fake main's chat channels. A turn is a FakeTurn (../engine.ts) run against this project: it commits versions,
 * updates the brief and records the turn's meta through the host built here.
 */
import { commitVersion, validatePlan } from "@slabyrinth/core";
import type { ChatEvent, IpcRequests, OutstandingIssues } from "../../../../shared/ipc";
import type { ChatItem } from "../../../../main/agent/provider/types";
import { FakeTurn } from "../engine";
import { EXAMPLE_A, EXAMPLE_B, TOWER, type FakeProject } from "../fixtures";
import { FAKE_MODELS } from "../models";
import { fakeRules as rules } from "../rules";
import type { FakeState, HandlerGroup } from "../state";
import { applyLenient, fail } from "../state";

type ChatChannels =
  | "chat:send"
  | "chat:estimate"
  | "chat:cancel"
  | "chat:retry"
  | "chat:selectAlternative"
  | "chat:continue"
  | "chat:previewSwitch"
  | "chat:setSelection"
  | "chat:setEffort"
  | "chat:newConversation";

type TurnHost = ConstructorParameters<typeof FakeTurn>[0];

/** The outstanding-issues notice lists at most this many issues. */
const OUTSTANDING_LIMIT = 20;
/** What a fake AI version costs (USD). */
const FAKE_VERSION_COST = 0.05;

export function chatHandlers(s: FakeState): HandlerGroup<ChatChannels> {
  const startTurn = (p: FakeProject, req: IpcRequests["chat:send"]["req"], reuseUser: boolean) =>
    startFakeTurn(s, p, req, reuseUser);
  return {
    "chat:send": (req) => startTurn(s.open(), req, false),
    "chat:estimate": ({ selection, intent }) => {
      const p = s.openId === null ? null : (s.projects.get(s.openId) ?? null);
      const sel = selection ?? p?.conversation.selection ?? s.settings.defaultSelection;
      const m = FAKE_MODELS.find((x) => x.modelId === sel.modelId);
      const plan = intent === "plan" || (intent !== "chat" && (p?.history.head ?? 0) > 0);
      const mult = { low: 0.6, medium: 1, high: 1.5, xhigh: 2.2, max: 3 }[sel.effort ?? "medium"];
      const out = (plan ? 6000 : 500) * mult;
      const inp = 14000;
      const cost = m?.pricing
        ? (inp * m.pricing.inputPerMTok + out * m.pricing.outputPerMTok) / 1_000_000
        : null;
      const speedTier = m?.speedTier ?? 2;
      const seconds = ((plan ? 32 : 8) * mult * 2) / speedTier;
      return { costUsd: cost, seconds, basis: "history" };
    },
    "chat:cancel": ({ turnId }) => {
      if (s.turn?.id === turnId) s.turn.t.cancelled = true;
    },
    "chat:retry": ({ selection }) => {
      const p = s.open();
      if (!s.lastUser) {
        const lastU = [...p.conversation.items].reverse().find((i) => i.type === "user");
        if (lastU?.type !== "user") return fail("validation", "Nothing to retry.");
        s.lastUser = { text: lastU.text };
      }
      if (selection) p.conversation.selection = selection;
      return startTurn(
        p,
        { text: s.lastUser.text, ...(s.lastUser.selection ? { selection: s.lastUser.selection } : {}) },
        true,
      );
    },
    "chat:selectAlternative": () => undefined,
    "chat:continue": () => startTurn(s.open(), { text: "Continue." }, true),
    "chat:previewSwitch": ({ selection }) => {
      const p = s.open();
      const sameModel = selection.modelId === p.conversation.selection.modelId;
      return sameModel
        ? { cacheReset: false, reasoningDropped: false, estimatedExtraCost: 0, messages: [] }
        : {
            cacheReset: true,
            reasoningDropped: true,
            estimatedExtraCost: 0.03,
            messages: ["The next message re-reads the conversation (about $0.03 once)."],
          };
    },
    "chat:setSelection": ({ selection }) => {
      const p = s.open();
      if (s.turn) return fail("busy", "Wait for the current reply to finish.");
      p.conversation.selection = { ...selection };
      const marker: ChatItem = {
        type: "marker",
        id: `m-${Date.now().toString(36)}`,
        kind: "selection_changed",
        selection: { ...selection },
        createdAt: new Date().toISOString(),
      };
      p.conversation.items.push(marker);
      return { selection: { ...selection } };
    },
    "chat:setEffort": ({ effort }) => {
      const p = s.open();
      p.conversation.selection = { ...p.conversation.selection, effort };
      return { selection: { ...p.conversation.selection } };
    },
    "chat:newConversation": () => s.snapshot(s.open()),
  };
}

/** Starts a fake turn on the project (rejects while one runs or without a key). */
function startFakeTurn(
  s: FakeState,
  p: FakeProject,
  req: IpcRequests["chat:send"]["req"],
  reuseUser: boolean,
): { turnId: string } {
  if (s.turn) return fail("busy", "A reply is still being written.");
  if (!s.hasKey) return fail("no_api_key", "Add your Anthropic API key to start.");
  const turnId = `turn-${Date.now().toString(36)}`;
  const t = new FakeTurn(turnHost(s, p), {
    turnId,
    text: req.text,
    ...(req.selection ? { selection: req.selection } : {}),
    ...(req.answers ? { answers: req.answers } : {}),
    intent: req.intent ?? "auto",
    model: p.conversation.selection,
    reuseUser,
    pendingQuestionsCallId: pendingQuestions(p),
  });
  s.turn = { id: turnId, t };
  s.lastUser = { text: req.text, ...(req.selection ? { selection: req.selection } : {}) };
  void t.run().finally(() => {
    if (s.turn?.id === turnId) s.turn = null;
  });
  return { turnId };
}

/** The call id of the model's last ask_questions the GM has not answered yet, else null. */
function pendingQuestions(p: FakeProject): string | null {
  const answered = new Set(
    p.conversation.items.flatMap((i) => (i.type === "tool_results" ? i.results.map((r) => r.callId) : [])),
  );
  for (let i = p.conversation.items.length - 1; i >= 0; i--) {
    const it = p.conversation.items[i];
    if (it?.type !== "assistant") continue;
    for (const part of it.parts)
      if (part.type === "tool_call" && part.name === "ask_questions" && !answered.has(part.callId))
        return part.callId;
    return null;
  }
  return null;
}

/** What a fake turn may do to the project: the same effects main's engine host has. */
function turnHost(s: FakeState, p: FakeProject): TurnHost {
  return {
    emitChat: (e: ChatEvent) => {
      s.emit("chat:event", e);
    },
    append: (item: ChatItem) => p.conversation.items.push(item),
    commit: (plan, _tool, messageId, summary, changes, ops) => {
      let next = plan;
      if (ops) {
        const r = applyLenient(plan, ops);
        if (!r.ok) throw new Error("edit rejected");
        next = r.plan;
      }
      const c = commitVersion(
        p.history,
        {
          plan: next,
          author: "ai",
          createdAt: new Date().toISOString(),
          summary,
          changeSummary: changes,
          cause: ops ? { type: "ops", ops } : { type: "create" },
          messageId,
          cost: { currency: "USD", amount: FAKE_VERSION_COST },
        },
        rules(),
      );
      p.history = c.history;
      s.touch(p);
      s.planChanged(p);
      return c.version.number;
    },
    updateBrief: (set) => {
      const skipped: string[] = [];
      const b = p.brief as Record<string, { source: string } | undefined>;
      for (const [k, v] of Object.entries(set)) {
        if (b[k]?.source === "user") skipped.push(k);
        else b[k] = v;
      }
      return { brief: structuredClone(p.brief), skipped };
    },
    currentPlan: () => s.planAt(p, p.history.head),
    brief: () => p.brief,
    finishMeta: (_turnId, itemIds, startedAt, usage, status, versions) => {
      const cost = {
        currency: "USD" as const,
        amount: (usage.inputTokens * 4 + usage.outputTokens * 20 + usage.cacheReadTokens * 0.2) / 1_000_000,
        estimated: true,
      };
      for (const id of itemIds) {
        p.conversation.meta[id] = {
          selection: { ...p.conversation.selection },
          servedBy: {
            providerId: p.conversation.selection.providerId,
            modelId: p.conversation.selection.modelId,
          },
          effortUsed: p.conversation.selection.effort,
          durationMs: Date.now() - startedAt,
          usage,
          cost,
          status: status === "error" ? "error" : status,
          versions,
        };
      }
      const tot = p.conversation.totals;
      tot.turns++;
      tot.usage.inputTokens += usage.inputTokens;
      tot.usage.outputTokens += usage.outputTokens;
      tot.cost = { currency: "USD", amount: (tot.cost?.amount ?? 0) + cost.amount, estimated: true };
      s.turn = null;
      s.touch(p);
    },
    pickPlan: (text) => {
      const t2 = text.toLowerCase();
      const plan = /forest|wilderness|clearing|ambush|road/.test(t2)
        ? EXAMPLE_B()
        : /tower|wizard/.test(t2)
          ? TOWER()
          : EXAMPLE_A();
      return { ...plan, id: crypto.randomUUID() };
    },
    sleep: s.sleep,
    outstanding: () => outstandingIssues(s, p),
  };
}

/** The notice of issues left on the head plan: set only when error-level issues remain (warnings listed alongside). */
function outstandingIssues(s: FakeState, p: FakeProject): OutstandingIssues | undefined {
  const plan = s.planAt(p, p.history.head);
  if (!plan) return undefined;
  const issues = validatePlan(plan, rules()).issues.filter((i) => i.severity !== "info");
  if (!issues.some((i) => i.severity === "error")) return undefined;
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const items = [...issues]
    .sort((x, y) => rank[x.severity] - rank[y.severity])
    .slice(0, OUTSTANDING_LIMIT)
    .map((i) => {
      const it: OutstandingIssues["items"][number] = {
        severity: i.severity,
        code: i.code,
        message: i.message,
      };
      if (i.hint !== undefined) it.hint = i.hint;
      if (i.elementId !== undefined) it.elementId = i.elementId;
      if (i.levelId !== undefined) it.levelId = i.levelId;
      if (i.cell !== undefined) it.cell = i.cell;
      return it;
    });
  return {
    version: p.history.head,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    items,
  };
}
