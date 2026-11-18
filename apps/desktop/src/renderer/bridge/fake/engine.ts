/**
 * Fake conversation engine: replays recorded-shape ChatEvent streams with realistic timing.
 * Event order follows the real turn loop (architecture §3.2): turn_started → user item → step_started →
 * deltas / tool calls / progress → assistant item → tool execution → tool_call_finished (+ plan:changed)
 * → tool_results item → next step … → usage → turn_finished.
 */
import type { DesignBrief, MapPlan, MapSelection, PlanOp } from "@slabyrinth/core";
import type { ChatEvent, AppError, OutstandingIssues } from "../../../shared/ipc";
import type { AssistantPart, ChatItem, ModelSelection, Usage } from "../../../main/agent/provider/types";

export interface EngineHost {
  emitChat(e: ChatEvent): void;
  append(item: ChatItem): void;
  /** Commit a plan version produced by a tool call; returns the new version number. */
  commit(
    plan: MapPlan,
    tool: "create_plan" | "edit_plan",
    messageId: string,
    summary: string,
    changes: string[],
    ops: PlanOp[] | null,
  ): number;
  updateBrief(set: Partial<DesignBrief>): { brief: DesignBrief; skipped: string[] };
  currentPlan(): MapPlan | null;
  brief(): DesignBrief;
  finishMeta(
    turnId: string,
    itemIds: string[],
    startedAt: number,
    usage: Usage,
    status: "complete" | "stopped" | "error",
    versions: number[],
  ): void;
  pickPlan(text: string): MapPlan;
  sleep(ms: number): Promise<void>;
  /** Plan-check summary of the head, for turns that changed the plan (undefined when clean). */
  outstanding(): OutstandingIssues | undefined;
}

export interface TurnRequest {
  turnId: string;
  text: string;
  selection?: MapSelection;
  answers?: { callId: string; answers: Array<{ id: string; answer: string | null }> };
  intent: "chat" | "plan" | "auto";
  model: ModelSelection;
  reuseUser: boolean;
  pendingQuestionsCallId: string | null;
}

class Cancelled extends Error {}

let seq = 0;
const nid = (p: string): string => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const now = (): string => new Date().toISOString();

export class FakeTurn {
  cancelled = false;
  private streamed = "";
  private readonly items: string[] = [];
  private readonly versions: number[] = [];
  private readonly started = Date.now();
  private readonly usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  constructor(
    private readonly host: EngineHost,
    private readonly req: TurnRequest,
  ) {}

  private async wait(ms: number): Promise<void> {
    await this.host.sleep(ms);
    if (this.cancelled) throw new Cancelled();
  }

  private emit(e: DistributiveOmit<ChatEvent, "turnId">): void {
    this.host.emitChat({ ...e, turnId: this.req.turnId });
  }

  private async streamText(step: number, text: string): Promise<void> {
    const words = text.split(/(?<=\s)/);
    for (let i = 0; i < words.length; i += 3) {
      const chunk = words.slice(i, i + 3).join("");
      this.streamed += chunk;
      this.emit({ type: "text_delta", step, text: chunk });
      await this.wait(45);
    }
  }

  private appendAssistant(
    parts: AssistantPart[],
    stopReason: "end_turn" | "tool_use" | "cancelled" = "end_turn",
  ): string {
    const id = nid("a");
    const item: ChatItem = {
      type: "assistant",
      id,
      turnId: this.req.turnId,
      parts,
      stopReason,
      servedBy: { providerId: this.req.model.providerId, modelId: this.req.model.modelId },
      createdAt: now(),
    };
    if (stopReason === "cancelled") item.excludedFromContext = true;
    this.host.append(item);
    this.emit({ type: "item_appended", item });
    this.items.push(id);
    this.streamed = "";
    return id;
  }

  private appendToolResult(callId: string, name: string, text: string, isError = false): void {
    const item: ChatItem = {
      type: "tool_results",
      id: nid("tr"),
      turnId: this.req.turnId,
      results: [{ callId, name, isError, content: [{ type: "text", text }] }],
      createdAt: now(),
    };
    this.host.append(item);
    this.emit({ type: "item_appended", item });
  }

  private addUsage(i: number, o: number): void {
    this.usage.inputTokens += i;
    this.usage.outputTokens += o;
    this.usage.cacheReadTokens += i * 2;
  }

  async run(): Promise<void> {
    const r = this.req;
    try {
      this.emit({ type: "turn_started", selection: r.model });
      if (r.answers)
        this.appendToolResult(
          r.answers.callId,
          "ask_questions",
          JSON.stringify({ answers: r.answers.answers }),
        );
      if (!r.reuseUser) {
        const u: ChatItem = { type: "user", id: nid("u"), text: r.text, createdAt: now() };
        if (r.selection) u.selection = r.selection;
        this.host.append(u);
        this.emit({ type: "item_appended", item: u });
      }
      await this.wait(500);
      const text = r.text.toLowerCase();
      const plan = this.host.currentPlan();
      if (/\b(fail|busy|overload)/.test(text)) await this.failing();
      else if (/\brefuse/.test(text)) await this.refusal();
      else if (text.includes("#ask"))
        await this.briefTurn(); // same trigger as the shell's fake engine
      else if (
        plan === null &&
        (r.answers !== undefined || r.intent === "plan" || /\b(draw|skip)\b/.test(text))
      )
        await this.createPlan();
      else if (plan === null) await this.briefTurn();
      else if (/\?\s*$/.test(r.text.trim()) && r.intent !== "plan") await this.chatOnly();
      else await this.editPlan(plan);
      this.emit({
        type: "usage",
        usage: this.usage,
        cost: this.cost(),
        totals: { usage: this.usage, cost: this.cost() },
      });
      this.host.finishMeta(r.turnId, this.items, this.started, this.usage, "complete", this.versions);
      const outstanding = this.versions.length > 0 ? this.host.outstanding() : undefined;
      this.emit({
        type: "turn_finished",
        stopReason: "end_turn",
        canContinue: false,
        canRetry: true,
        ...(outstanding ? { outstandingIssues: outstanding } : {}),
      });
    } catch (e) {
      if (e instanceof Cancelled) {
        if (this.streamed.length > 0)
          this.appendAssistant([{ type: "text", text: this.streamed }], "cancelled");
        this.host.finishMeta(r.turnId, this.items, this.started, this.usage, "stopped", this.versions);
        const outstanding = this.versions.length > 0 ? this.host.outstanding() : undefined;
        this.emit({
          type: "turn_finished",
          stopReason: "cancelled",
          canContinue: false,
          canRetry: true,
          ...(outstanding ? { outstandingIssues: outstanding } : {}),
        });
        return;
      }
      const error: AppError =
        e instanceof FakeProviderFailure
          ? e.appError
          : { code: "internal", message: e instanceof Error ? e.message : String(e) };
      this.host.finishMeta(r.turnId, this.items, this.started, this.usage, "error", this.versions);
      this.emit({ type: "turn_failed", error, canRetry: true });
    }
  }

  private cost(): { currency: "USD"; amount: number; estimated: boolean } {
    const amount =
      (this.usage.inputTokens * 4 + this.usage.outputTokens * 20 + this.usage.cacheReadTokens * 0.2) /
      1_000_000;
    return { currency: "USD", amount, estimated: true };
  }

  private async briefTurn(): Promise<void> {
    const text = this.req.text.toLowerCase();
    const forest = /forest|wood|road|ambush|clearing/.test(text);
    const tower = /tower|wizard/.test(text);
    const town = /town|market|village/.test(text);
    this.emit({
      type: "step_started",
      step: 0,
      servedBy: { providerId: this.req.model.providerId, modelId: this.req.model.modelId },
    });
    const kind = forest ? "forest road" : tower ? "wizard's tower" : town ? "market town" : "drowned crypt";
    await this.streamText(
      0,
      `A ${kind} — lovely. I've started the brief at the top. Three quick things, or I can choose for you:`,
    );
    const briefCall = nid("call");
    this.emit({ type: "tool_call_started", step: 0, callId: briefCall, name: "update_brief" });
    await this.wait(300);
    const set: Partial<DesignBrief> = {
      mapType: {
        value: forest
          ? "Wilderness · forest road"
          : tower
            ? "Tower"
            : town
              ? "Town · market"
              : "Dungeon · crypt",
        source: "ai",
      },
      tone: {
        value: forest
          ? "Tense, overgrown"
          : tower
            ? "Arcane, cluttered"
            : town
              ? "Busy, friendly"
              : "Gothic, drowned, melancholy",
        source: "ai",
      },
      levels: {
        value: {
          count: tower ? 3 : forest || town ? 1 : 2,
          names: tower
            ? ["Library", "Laboratory", "Observatory"]
            : forest || town
              ? ["Ground"]
              : ["Upper Crypts", "Cistern Depths"],
        },
        source: "ai",
      },
    };
    if (/daggerheart/.test(text)) set.system = { value: "daggerheart", source: "ai" };
    const { brief, skipped } = this.host.updateBrief(set);
    this.emit({ type: "brief_updated", brief, skipped });
    this.emit({
      type: "tool_call_finished",
      callId: briefCall,
      name: "update_brief",
      ok: true,
      summary: "Brief updated",
    });
    const qCall = nid("call");
    this.emit({ type: "tool_call_started", step: 0, callId: qCall, name: "ask_questions" });
    const questions = [
      { id: "tier", text: "Party tier?", default: "Tier 2", options: ["Tier 1", "Tier 2", "Tier 3"] },
      {
        id: "size",
        text: "How big per level?",
        default: "medium, about 40×30 squares",
        options: ["Small", "Medium", "Large"],
      },
      forest || town
        ? {
            id: "feature",
            text: "What's the centrepiece?",
            default: "a ravine crossing",
            options: ["A ravine crossing", "A ruined watchtower", "A river ford"],
          }
        : {
            id: "level2",
            text: "What's down on level 2?",
            default: "a cistern",
            options: ["A drowned cistern", "Catacombs", "The saint's tomb"],
          },
    ];
    await this.wait(400);
    this.emit({ type: "questions", callId: qCall, questions });
    this.addUsage(9000, 420);
    this.appendAssistant(
      [
        {
          type: "text",
          text: `A ${kind} — lovely. I've started the brief at the top. Three quick things, or I can choose for you:`,
        },
        { type: "tool_call", callId: briefCall, name: "update_brief", input: { set } },
        { type: "tool_call", callId: qCall, name: "ask_questions", input: { questions } },
      ],
      "tool_use",
    );
    this.appendToolResult(briefCall, "update_brief", JSON.stringify({ ok: true, skipped }));
  }

  private async createPlan(): Promise<void> {
    const sb = { providerId: this.req.model.providerId, modelId: this.req.model.modelId };
    this.emit({ type: "step_started", step: 0, servedBy: sb });
    const intro = "Drawing the first plan now. I'll number every room and write short GM notes as I go.";
    await this.streamText(0, intro);
    const call = nid("call");
    this.emit({ type: "tool_call_started", step: 0, callId: call, name: "create_plan" });
    const plan = this.host.pickPlan(`${this.req.text} ${JSON.stringify(this.host.brief())}`);
    const steps: Array<[Extract<ChatEvent, { type: "progress" }>["step"], string]> = [
      ["reading_brief", "Reading the brief"],
      ...plan.levels.map((l, i): [Extract<ChatEvent, { type: "progress" }>["step"], string] => [
        "laying_out_level",
        `Laying out Level ${i + 1} · ${l.name}`,
      ]),
      ["placing_openings", "Placing doors and stairs"],
      ["furnishing", "Furnishing"],
      ["writing_notes", "Writing GM notes"],
    ];
    let bytes = 0;
    for (const [step, label] of steps) {
      this.emit({ type: "progress", step, label });
      for (let k = 0; k < 4; k++) {
        bytes += 900 + Math.round(Math.random() * 600);
        this.emit({ type: "tool_call_progress", callId: call, bytes });
        await this.wait(380);
      }
    }
    const aid = this.appendAssistant(
      [
        { type: "text", text: intro },
        { type: "tool_call", callId: call, name: "create_plan", input: { title: plan.title } },
      ],
      "tool_use",
    );
    this.emit({ type: "progress", step: "checking", label: "Checking the plan" });
    await this.wait(700);
    const rooms = plan.levels.reduce((n, l) => n + l.areas.filter((a) => a.key !== undefined).length, 0);
    const v = this.host.commit(
      plan,
      "create_plan",
      aid,
      `First plan · ${plan.levels.length} level${plan.levels.length > 1 ? "s" : ""}`,
      [
        `Drew ${plan.levels.length} level${plan.levels.length > 1 ? "s" : ""}: ${plan.levels.map((l) => l.name).join(", ")}`,
        `Numbered ${rooms} rooms and wrote GM notes`,
        ...(plan.links.length > 0
          ? [`Linked the levels with ${plan.links.length} stair${plan.links.length > 1 ? "s" : ""}`]
          : []),
      ],
      null,
    );
    this.versions.push(v);
    this.emit({
      type: "tool_call_finished",
      callId: call,
      name: "create_plan",
      ok: true,
      summary: `Plan v${v} created`,
      newVersion: v,
    });
    this.appendToolResult(call, "create_plan", JSON.stringify({ status: "applied", version: v }));
    this.addUsage(14000, 7200);
    this.emit({ type: "step_started", step: 1, servedBy: sb });
    const outro = `Here's **${plan.title}**: ${plan.levels.length} level${plan.levels.length > 1 ? "s" : ""} and ${rooms} numbered rooms. Click a room on the map to point at it, and tell me what to change. When it looks right, approve it.`;
    await this.streamText(1, outro);
    this.addUsage(15000, 120);
    this.appendAssistant([{ type: "text", text: outro }]);
  }

  private async editPlan(plan: MapPlan): Promise<void> {
    const sb = { providerId: this.req.model.providerId, modelId: this.req.model.modelId };
    this.emit({ type: "step_started", step: 0, servedBy: sb });
    const areas = plan.levels.flatMap((l) => l.areas.filter((a) => a.key !== undefined));
    const targetId = this.req.selection?.areaIds[0];
    const target = areas.find((a) => a.id === targetId) ?? areas[0];
    if (!target) throw new Error("no rooms to edit");
    const intro = `On it — reworking ${target.name ?? "that room"} (room ${target.key ?? "?"}).`;
    await this.streamText(0, intro);
    const call = nid("call");
    this.emit({ type: "tool_call_started", step: 0, callId: call, name: "edit_plan" });
    for (const [step, label] of [
      ["placing_openings", "Placing doors and stairs"],
      ["writing_notes", "Writing GM notes"],
    ] as const) {
      this.emit({ type: "progress", step, label });
      await this.wait(900);
      this.emit({ type: "tool_call_progress", callId: call, bytes: 800 });
    }
    const aid = this.appendAssistant(
      [
        { type: "text", text: intro },
        { type: "tool_call", callId: call, name: "edit_plan", input: { ops: [] } },
      ],
      "tool_use",
    );
    this.emit({ type: "progress", step: "checking", label: "Checking the plan" });
    await this.wait(500);
    const note = `${target.notes ?? ""} ${this.req.text.trim().replace(/\.?$/, ".")}`.trim().slice(0, 1900);
    const ops: PlanOp[] = [{ op: "update", id: target.id, set: { notes: note } }];
    const k = target.key ?? "?";
    const v = this.host.commit(
      plan,
      "edit_plan",
      aid,
      `Edited ${circled(k)} ${target.name ?? ""}`.trim(),
      [`Rewrote GM notes for ${circled(k)} ${target.name ?? ""}`.trim()],
      ops,
    );
    this.versions.push(v);
    this.emit({
      type: "tool_call_finished",
      callId: call,
      name: "edit_plan",
      ok: true,
      summary: `Plan v${v}`,
      newVersion: v,
    });
    this.appendToolResult(call, "edit_plan", JSON.stringify({ status: "applied", version: v }));
    this.emit({ type: "step_started", step: 1, servedBy: sb });
    const outro = `Done. I folded that into the GM notes for ${circled(k)} ${target.name ?? ""} — have a look in the room key, and undo if it isn't what you meant.`;
    await this.streamText(1, outro);
    this.addUsage(22000, 1900);
    this.appendAssistant([{ type: "text", text: outro }]);
  }

  private async chatOnly(): Promise<void> {
    this.emit({
      type: "step_started",
      step: 0,
      servedBy: { providerId: this.req.model.providerId, modelId: this.req.model.modelId },
    });
    const answer =
      "Good question. Waist-deep water counts as difficult terrain, and anything deeper means swimming — I can deepen the east side of the cistern if you want a real obstacle there. Say the word and I'll change the plan.\n\nIf you'd rather keep it simple, leave it as it is: the stair landing already gives the party a dry way across.";
    await this.streamText(0, answer);
    this.addUsage(18000, 260);
    this.appendAssistant([{ type: "text", text: answer }]);
  }

  private async refusal(): Promise<void> {
    this.emit({
      type: "step_started",
      step: 0,
      servedBy: { providerId: this.req.model.providerId, modelId: this.req.model.modelId },
    });
    const t = "I can't help with that one.";
    await this.streamText(0, t);
    this.emit({ type: "notice", kind: "refusal", text: "The plan wasn't changed." });
    this.appendAssistant([
      { type: "text", text: t },
      { type: "notice", kind: "refusal", text: "The plan wasn't changed." },
    ]);
  }

  private async failing(): Promise<void> {
    this.emit({
      type: "step_started",
      step: 0,
      servedBy: { providerId: this.req.model.providerId, modelId: this.req.model.modelId },
    });
    await this.wait(900);
    this.emit({ type: "notice", kind: "fallback", text: "Anthropic is busy — retrying in 12s." });
    await this.wait(1200);
    throw new FakeProviderFailure({
      code: "provider",
      message: "Anthropic is overloaded.",
      provider: {
        kind: "overloaded",
        retryable: true,
        httpStatus: 529,
        requestId: "req_011CZ8fake",
        message: "Overloaded",
      },
    });
  }
}

export class FakeProviderFailure extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export function circled(key: string): string {
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? (CIRCLED[n - 1] as string) : `#${key}`;
}
