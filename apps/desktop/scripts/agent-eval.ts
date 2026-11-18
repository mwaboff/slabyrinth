/**
 * Headless eval harness (architecture §7.3 "Live", §8.3 WP4): runs N briefs through the REAL ConversationEngine and
 * reports the validation error rate, retries, tokens and cost. Not part of CI.
 *
 *   ANTHROPIC_API_KEY=… npx tsx apps/desktop/scripts/agent-eval.ts --yes [--model claude-opus-5-5] [--effort medium]
 *       [--n 10] [--briefs briefs.json] [--json out.json]
 *
 * It spends real money on the user's key, so it refuses to run without --yes and prints an estimate first.
 * Acceptance target: ≥ 90% of first drafts valid within 2 retries on Opus 5.5 at medium.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SlabyrinthConversationEngine } from "../src/main/agent/engine";
import { ZERO_USAGE, addCost, addUsage } from "../src/main/agent/cost";
import { createDefaultRegistry } from "../src/main/agent/provider/registry";
import type {
  Cost,
  EffortLevel,
  ModelSelection,
  ProviderRegistry,
  Usage,
} from "../src/main/agent/provider/types";
import { MemoryHost, newProject } from "../src/main/agent/testing/memoryHost";

export const DEFAULT_BRIEFS: readonly string[] = [
  "A two-level crypt under a ruined abbey, half-flooded, for a Tier 2 Daggerheart party.",
  "A four-storey wizard's tower with a library, a lab and a rooftop observatory.",
  "A small riverside market square with a tavern and a smithy I can walk into.",
  "A forest road ambush site with a ravine, a fallen tree and archer cover.",
  "A goblin cave warren with three chambers, a chasm and a hidden exit, for level 3 D&D characters.",
  "A haunted manor ground floor: entrance hall, dining room, kitchen, servants' stair and a locked study.",
  "A dwarven mine entrance with rails, a collapsed tunnel and a guard post.",
  "A smugglers' sea cave with a dock, a hidden storeroom and a ladder up to a cliff-top shack.",
  "A temple of a sun god: nave, altar dais, two side chapels and a crypt below.",
  "A bandit camp in a clearing: tents, a palisade, a lookout tower and a stream.",
];

export interface BriefResult {
  brief: string;
  ok: boolean;
  /** create_plan attempts until the first accepted one (1 = valid first time); null = never valid. */
  createAttempts: number | null;
  createRejected: number;
  editCalls: number;
  editRejected: number;
  questionRounds: number;
  turns: number;
  usage: Usage;
  cost: Cost | null;
  error?: string;
}

export interface EvalReport {
  selection: ModelSelection;
  results: BriefResult[];
  summary: {
    briefs: number;
    validFirstDraftWithin2Retries: number;
    validFirstDraftRate: number;
    /** Rejected plan-tool calls ÷ all plan-tool calls. */
    validationErrorRate: number;
    retries: number;
    usage: Usage;
    cost: Cost | null;
  };
}

export interface EvalOptions {
  briefs: readonly string[];
  selection: ModelSelection;
  /** Provider registry; the real Anthropic one by default. Tests pass a fake. */
  registry?: ProviderRegistry;
  apiKey?: string | null;
  maxQuestionRounds?: number;
  log?: (line: string) => void;
}

async function runBrief(brief: string, o: EvalOptions): Promise<BriefResult> {
  const host = new MemoryHost(newProject(o.selection), {
    apiKey: o.apiKey === undefined ? "eval" : o.apiKey,
  });
  const engine = new SlabyrinthConversationEngine(host, o.registry ? { registry: o.registry } : {});
  const r: BriefResult = {
    brief,
    ok: false,
    createAttempts: null,
    createRejected: 0,
    editCalls: 0,
    editRejected: 0,
    questionRounds: 0,
    turns: 0,
    usage: ZERO_USAGE,
    cost: null,
  };
  try {
    await engine.send({ text: brief, intent: "plan" });
    await engine.whenIdle();
    r.turns++;
    for (let round = 0; round < (o.maxQuestionRounds ?? 2) && host.project?.history.head === 0; round++) {
      const pending = host.conv().pendingQuestions;
      const failed = host.eventsOf("turn_failed").at(-1);
      if (failed) throw new Error(failed.error.message);
      if (pending) {
        r.questionRounds++;
        const qs =
          host
            .eventsOf("questions")
            .filter((q) => q.callId === pending.callId)
            .at(-1)?.questions ?? [];
        await engine.send({
          text: "You decide. Please draw the first plan now.",
          answers: { callId: pending.callId, answers: qs.map((q) => ({ id: q.id, answer: "you_decide" })) },
          intent: "plan",
        });
      } else {
        await engine.send({ text: "Please draw the first plan now.", intent: "plan" });
      }
      await engine.whenIdle();
      r.turns++;
    }
    const failed = host.eventsOf("turn_failed").at(-1);
    if (failed && host.project?.history.head === 0) throw new Error(failed.error.message);
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  let creates = 0;
  for (const e of host.eventsOf("tool_call_finished")) {
    if (e.name === "create_plan") {
      creates++;
      if (!e.ok) r.createRejected++;
      else r.createAttempts ??= creates;
    } else if (e.name === "edit_plan") {
      r.editCalls++;
      if (!e.ok) r.editRejected++;
    }
  }
  r.ok = (host.project?.history.head ?? 0) > 0;
  const conv = host.project ? host.conv() : null;
  r.usage = conv?.totals.usage ?? ZERO_USAGE;
  r.cost = conv?.totals.cost ?? null;
  return r;
}

export async function runEval(o: EvalOptions): Promise<EvalReport> {
  const results: BriefResult[] = [];
  for (const [i, brief] of o.briefs.entries()) {
    o.log?.(`[${i + 1}/${o.briefs.length}] ${brief}`);
    const r = await runBrief(brief, o);
    o.log?.(
      `    ${r.ok ? "ok" : "FAILED"} · create attempts ${r.createAttempts ?? "-"} · rejected ${r.createRejected + r.editRejected} · $${(r.cost?.amount ?? 0).toFixed(3)}${r.error ? ` · ${r.error}` : ""}`,
    );
    results.push(r);
  }
  const planCalls = results.reduce(
    (s, r) => s + r.createRejected + (r.createAttempts !== null ? 1 : 0) + r.editCalls,
    0,
  );
  const rejected = results.reduce((s, r) => s + r.createRejected + r.editRejected, 0);
  const within = results.filter((r) => r.createAttempts !== null && r.createAttempts <= 3).length;
  return {
    selection: o.selection,
    results,
    summary: {
      briefs: results.length,
      validFirstDraftWithin2Retries: within,
      validFirstDraftRate: results.length === 0 ? 0 : within / results.length,
      validationErrorRate: planCalls === 0 ? 0 : rejected / planCalls,
      retries: rejected,
      usage: results.reduce((u, r) => addUsage(u, r.usage), ZERO_USAGE),
      cost: results.reduce<Cost | null>((c, r) => addCost(c, r.cost), null),
    },
  };
}

export function formatReport(rep: EvalReport): string {
  const s = rep.summary;
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  return [
    `Model ${rep.selection.modelId} · effort ${rep.selection.effort ?? "default"} · ${s.briefs} briefs`,
    `First drafts valid within 2 retries: ${s.validFirstDraftWithin2Retries}/${s.briefs} (${pct(s.validFirstDraftRate)}; target ≥ 90%)`,
    `Validation error rate: ${pct(s.validationErrorRate)} · rejected calls (retries): ${s.retries}`,
    `Tokens: in ${s.usage.inputTokens} · cache read ${s.usage.cacheReadTokens} · cache write ${s.usage.cacheWriteTokens} · out ${s.usage.outputTokens}`,
    `Cost (estimate): $${(s.cost?.amount ?? 0).toFixed(2)}`,
  ].join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apiKey = process.env["ANTHROPIC_API_KEY"] ?? null;
  const n = Number(arg("n") ?? DEFAULT_BRIEFS.length);
  const file = arg("briefs");
  const briefs = (file ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : [...DEFAULT_BRIEFS]).slice(
    0,
    n,
  );
  const selection: ModelSelection = {
    providerId: "anthropic",
    modelId: arg("model") ?? "claude-opus-5-5",
    effort: (arg("effort") ?? "medium") as EffortLevel,
  };
  console.log(
    `About to run ${briefs.length} briefs on ${selection.modelId} (${String(selection.effort)}). Expect roughly $0.10–$0.60 per brief on your key.`,
  );
  if (!process.argv.includes("--yes")) {
    console.log("Nothing was sent. Re-run with --yes to spend real tokens.");
    return;
  }
  if (!apiKey) {
    console.error("Set ANTHROPIC_API_KEY first.");
    process.exitCode = 1;
    return;
  }
  const report = await runEval({
    briefs,
    selection,
    apiKey,
    registry: createDefaultRegistry(),
    log: (l) => {
      console.log(l);
    },
  });
  console.log(`\n${formatReport(report)}`);
  const out = arg("json");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
