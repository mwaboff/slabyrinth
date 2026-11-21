/**
 * Fake `window.slabyrinth` for running the renderer in a plain browser and in tests.
 * Implements every request channel of shared/ipc.ts with in-memory state and the real core history
 * functions, and emits the same events main will. Never touches the real clipboard, TaleSpire or disk.
 *
 * Scenario flags (URL `?fake=a,b` or createFakeBridge({ scenario })):
 *   setup   → first run (Setup window)      nokey → no API key stored
 *   nots    → TaleSpire not found           empty → no projects yet
 *   win     → platform win32 (native window controls)
 *   update  → a newer release is available (header chip)
 */
import {
  applyOps,
  approve as approveHistory,
  commitVersion,
  diffPlans,
  redo as redoHistory,
  reconstruct,
  restore as restoreHistory,
  undo as undoHistory,
  validatePlan,
} from "@slabyrinth/core";
import { countPlanRooms } from "@slabyrinth/core";
import { bundledPalettes, resolvePalettesData } from "@slabyrinth/core/palette";
import type { DesignBrief, MapPlan, PlanOp } from "@slabyrinth/core";
import type {
  AppError,
  ChatEvent,
  IpcEvents,
  IpcRequests,
  OutstandingIssues,
  ProjectSnapshot,
  Result,
  SlabyrinthApi,
} from "../../../shared/ipc";
import type { AppSettings, Phase, ProjectFile } from "../../../shared/project";
import type { ChatItem, Usage } from "../../../main/agent/provider/types";
import { estimateSlabs, fakeCompile, levelBytes } from "./compile";
import { thumbnail } from "./thumbs";
import {
  EXAMPLE_A,
  EXAMPLE_B,
  TOWER,
  makeFixtureProjects,
  newUntitledProject,
  type FakeProject,
} from "./fixtures";
import { fakeRules as rules } from "./rules";
import { FakeTurn } from "./engine";
import { FAKE_MODELS, FAKE_PROVIDERS } from "./models";

export interface FakeScenario {
  setup?: boolean;
  nokey?: boolean;
  nots?: boolean;
  empty?: boolean;
  win?: boolean;
  update?: boolean;
}

export interface FakeOptions {
  scenario?: FakeScenario;
  /** Multiplies every simulated delay (0 = immediate; tests). */
  speed?: number;
}

class FakeFailure extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message);
  }
}
const fail = (code: AppError["code"], message: string): never => {
  throw new FakeFailure({ code, message });
};

type Handlers = {
  [C in keyof IpcRequests]: (
    req: IpcRequests[C]["req"],
  ) => IpcRequests[C]["res"] | Promise<IpcRequests[C]["res"]>;
};

const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function parseScenario(search: string): FakeScenario {
  const p = new URLSearchParams(search).get("fake") ?? "";
  const flags = new Set(p.split(",").map((s) => s.trim()));
  return {
    setup: flags.has("setup"),
    nokey: flags.has("nokey") || flags.has("setup"),
    nots: flags.has("nots"),
    empty: flags.has("empty") || flags.has("setup"),
    win: flags.has("win"),
    update: flags.has("update"),
  };
}

/**
 * Like main (ports/core.ts applyChecked): edits are not rejected just because the map already has playability
 * problems; structural op errors still fail.
 */
function applyLenient(plan: MapPlan, ops: PlanOp[]): ReturnType<typeof applyOps> {
  const r = applyOps(plan, ops, rules());
  if (r.ok || r.opErrors.length > 0) return r;
  return applyOps(plan, ops, rules(), { validate: false });
}

export function createFakeBridge(opts: FakeOptions = {}): SlabyrinthApi & {
  emit: <C extends keyof IpcEvents>(c: C, p: IpcEvents[C]) => void;
  projects: Map<string, FakeProject>;
} {
  const scenario = opts.scenario ?? {};
  const speed = opts.speed ?? 1;
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms * speed));

  const emit = <C extends keyof IpcEvents>(channel: C, payload: IpcEvents[C]): void => {
    const set = listeners.get(channel);
    if (!set) return;
    for (const l of [...set]) l(payload);
  };

  const projects = new Map<string, FakeProject>();
  if (scenario.empty !== true) for (const p of makeFixtureProjects()) projects.set(p.id, p);
  let recent = [...projects.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((p) => p.path);
  let openId: string | null = null;
  let turn: { id: string; t: FakeTurn } | null = null;
  let untitled = 0;
  let lastUser: { text: string; selection?: IpcRequests["chat:send"]["req"]["selection"] } | null = null;
  let tsRunning = false;
  let hasKey = scenario.nokey !== true;
  let lastCheckedAt: string | null = null;
  const updateStatus = (): IpcRequests["updates:status"]["res"] => {
    const update =
      scenario.update === true
        ? {
            version: "0.2.0",
            tag: "v0.2.0",
            publishedAt: "2026-12-01T12:00:00Z",
            notes: "### Added\n- Stamps for repeated rooms\n\n### Fixed\n- Stairs against walls",
            url: "https://github.com/mwaboff/slabyrinth/releases/tag/v0.2.0",
          }
        : null;
    return {
      state: update ? "available" : lastCheckedAt !== null ? "up_to_date" : "idle",
      currentVersion: "0.1.0",
      lastCheckedAt,
      update,
      skipped: update !== null && settings.updates.skippedVersion === update.version,
    };
  };
  let keyHint = "sk-ant-…a1B2";
  const uiState = new Map<
    string,
    {
      ui: ProjectFile["ui"];
      pasteGuide: NonNullable<ProjectFile["pasteGuide"]> | null;
      pngExport: NonNullable<ProjectFile["pngExport"]> | null;
    }
  >();
  let catalogState: "no_install" | "fresh" = scenario.nots === true ? "no_install" : "fresh";

  let settings: AppSettings = {
    schema: "slabyrinth/settings@1",
    defaultSelection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
    providers: {
      anthropic: { enabled: true },
      lmstudio: { enabled: false, baseUrl: "http://localhost:1234/v1" },
    },
    smartEffort: true,
    showReasoning: false,
    spending: {
      perActionWarnUsd: 1,
      perProjectWarnUsd: 10,
      allTime: { usage: zeroUsage(), cost: { currency: "USD", amount: 4.12, estimated: true } },
    },
    talespire: {
      installPath: scenario.nots === true ? null : "D:\\SteamLibrary\\steamapps\\common\\TaleSpire",
      lastScanAt: new Date().toISOString(),
      levelLayout: "stacked",
      alignmentMarkers: false,
    },
    projects: { folder: "C:\\Users\\GM\\Documents\\Slabyrinth", recent },
    ui: { theme: "dark", mapThemeId: "auto", gridVisible: true, onLaunch: "home" },
    suppressAssetWarning: false,
    updates: { autoCheck: true },
    setupCompleted: scenario.setup !== true,
    defaultSystem: scenario.setup === true ? null : { system: "daggerheart" },
  };

  const open = (): FakeProject => {
    const p = openId === null ? undefined : projects.get(openId);
    if (!p) return fail("no_project", "No project is open.");
    return p;
  };
  const planAt = (p: FakeProject, n: number): MapPlan | null => {
    if (n === 0) return null;
    const r = reconstruct(p.history, n, rules());
    return r.ok ? r.plan : null;
  };
  const phaseOf = (p: FakeProject): Phase =>
    p.history.approvedVersion !== null ? "build" : p.history.head > 0 ? "plan" : "brief";
  const touch = (p: FakeProject): void => {
    p.updatedAt = new Date().toISOString();
    p.lastActivityAt = p.updatedAt;
    recent = [p.path, ...recent.filter((x) => x !== p.path)].slice(0, 10);
  };

  const snapshot = (p: FakeProject): ProjectSnapshot => ({
    projectId: p.id,
    name: p.name,
    filePath: p.path,
    dirty: false,
    plan: planAt(p, p.history.head),
    head: p.history.head,
    versions: p.history.versions.map((v) => {
      const { cause, ...rest } = v;
      delete rest.snapshot;
      return { ...structuredClone(rest), causeType: cause.type };
    }),
    undone: [...p.history.undone],
    approvedVersion: p.history.approvedVersion,
    brief: structuredClone(p.brief),
    builds: structuredClone(p.builds),
    conversation: {
      id: p.conversation.id,
      selection: { ...p.conversation.selection },
      phase: phaseOf(p),
      items: structuredClone(p.conversation.items),
      meta: structuredClone(p.conversation.meta),
      totals: structuredClone(p.conversation.totals),
      toolMode: p.conversation.toolMode,
    },
    busy: turn ? { turnId: turn.id } : null,
    ui: structuredClone(uiState.get(p.id)?.ui ?? { tab: "map" }),
    pasteGuide: uiState.get(p.id)?.pasteGuide ?? null,
    pngExport: uiState.get(p.id)?.pngExport ?? null,
  });

  const planChanged = (p: FakeProject): void => {
    const v = p.history.versions.find((x) => x.number === p.history.head);
    if (!v) return;
    const { cause, ...rest } = v;
    delete rest.snapshot;
    emit("plan:changed", {
      head: p.history.head,
      plan: planAt(p, p.history.head),
      version: { ...rest, causeType: cause.type },
    });
  };

  const pendingQuestions = (p: FakeProject): string | null => {
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
  };

  const startTurn = (
    p: FakeProject,
    req: IpcRequests["chat:send"]["req"],
    reuseUser: boolean,
  ): { turnId: string } => {
    if (turn) return fail("busy", "A reply is still being written.");
    if (!hasKey) return fail("no_api_key", "Add your Anthropic API key to start.");
    const turnId = `turn-${Date.now().toString(36)}`;
    const t = new FakeTurn(
      {
        emitChat: (e: ChatEvent) => {
          emit("chat:event", e);
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
              cost: { currency: "USD", amount: 0.05 },
            },
            rules(),
          );
          p.history = c.history;
          touch(p);
          planChanged(p);
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
        currentPlan: () => planAt(p, p.history.head),
        brief: () => p.brief,
        finishMeta: (_turnId, itemIds, startedAt, usage, status, versions) => {
          const cost = {
            currency: "USD" as const,
            amount:
              (usage.inputTokens * 4 + usage.outputTokens * 20 + usage.cacheReadTokens * 0.2) / 1_000_000,
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
          turn = null;
          touch(p);
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
        sleep,
        outstanding: () => {
          const plan = planAt(p, p.history.head);
          if (!plan) return undefined;
          const issues = validatePlan(plan, rules()).issues.filter((i) => i.severity !== "info");
          // set only when error-level issues remain (warnings are listed alongside)
          if (!issues.some((i) => i.severity === "error")) return undefined;
          const rank = { error: 0, warning: 1, info: 2 } as const;
          const items = [...issues]
            .sort((x, y) => rank[x.severity] - rank[y.severity])
            .slice(0, 20)
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
        },
      },
      {
        turnId,
        text: req.text,
        ...(req.selection ? { selection: req.selection } : {}),
        ...(req.answers ? { answers: req.answers } : {}),
        intent: req.intent ?? "auto",
        model: p.conversation.selection,
        reuseUser,
        pendingQuestionsCallId: pendingQuestions(p),
      },
    );
    turn = { id: turnId, t };
    lastUser = { text: req.text, ...(req.selection ? { selection: req.selection } : {}) };
    void t.run().finally(() => {
      if (turn?.id === turnId) turn = null;
    });
    return { turnId };
  };

  const markCopied = (chunk: { buildId: string; chunkId: string } | undefined): void => {
    if (!chunk || openId === null) return;
    const b = projects.get(openId)?.builds.find((x) => x.id === chunk.buildId);
    for (const l of b?.levels ?? [])
      for (const c of l.chunks) if (c.id === chunk.chunkId) c.copiedAt = new Date().toISOString();
  };

  const listEntry = (p: FakeProject): IpcRequests["project:list"]["res"][number] => {
    const plan = planAt(p, p.history.head);
    return {
      path: p.path,
      name: p.name,
      updatedAt: p.updatedAt,
      exists: true,
      levels: plan?.levels.length ?? 0,
      rooms: countPlanRooms(plan),
      phase: phaseOf(p),
    };
  };

  const handlers: Handlers = {
    "app:getInfo": () => ({
      version: "0.1.0-fake",
      platform: scenario.win === true ? "win32" : "linux",
      userDataPath: "C:\\Users\\GM\\AppData\\Roaming\\Slabyrinth",
    }),
    "settings:get": () => structuredClone(settings),
    "settings:update": (patch) => {
      settings = { ...settings, ...structuredClone(patch) };
      emit("settings:changed", structuredClone(settings));
      return structuredClone(settings);
    },
    "secrets:setApiKey": async ({ apiKey, verify }) => {
      await sleep(400);
      if (!apiKey.startsWith("sk-ant-"))
        return fail("validation", "That doesn't look like an Anthropic key.");
      hasKey = true;
      keyHint = `sk-ant-…${apiKey.slice(-4)}`;
      return verify === true
        ? { stored: true, backend: "os", check: { ok: true } }
        : { stored: true, backend: "os" };
    },
    "secrets:storeWeak": () => ({ stored: hasKey, backend: hasKey ? "os" : "memory_only" }),
    "secrets:clearApiKey": () => {
      hasKey = false;
    },
    "secrets:status": () => ({
      anthropic: { hasKey, backend: hasKey ? "os" : null, hint: hasKey ? keyHint : null },
      lmstudio: { hasKey: false, backend: null, hint: null },
    }),
    // v1 main lists only Anthropic; the UI draws LM Studio as a static "Later" card.
    "providers:list": () => structuredClone(FAKE_PROVIDERS.filter((p) => p.id === "anthropic")),
    "dialog:pickFolder": async ({ purpose }) => {
      await sleep(300);
      if (purpose === "projects") return { path: "D:\\Maps\\Slabyrinth", valid: true };
      return { path: "D:\\SteamLibrary\\steamapps\\common\\TaleSpire", valid: true };
    },
    "providers:check": async () => {
      await sleep(700);
      if (!hasKey)
        return {
          ok: false,
          error: { kind: "auth", retryable: false, httpStatus: 401, message: "Anthropic rejected that key." },
        };
      return { ok: true };
    },
    "models:list": () => structuredClone(FAKE_MODELS),
    "project:new": ({ name }) => {
      untitled++;
      const p = newUntitledProject(
        `untitled-${Date.now().toString(36)}`,
        name ?? (untitled > 1 ? `Untitled map ${untitled}` : "Untitled map"),
      );
      p.conversation.selection = { ...settings.defaultSelection };
      projects.set(p.id, p);
      openId = p.id;
      touch(p);
      return snapshot(p);
    },
    "project:open": ({ path }) => {
      const p =
        [...projects.values()].find((x) => x.path === path) ?? (path === undefined ? undefined : undefined);
      if (!p) {
        if (path === undefined) return null; // dialog cancelled
        return fail("not_found", "That file isn't a Slabyrinth project.");
      }
      openId = p.id;
      return snapshot(p);
    },
    "project:saveCopyAs": () => ({ path: `${open().path.replace(/\.slabyrinth$/, "")} (copy).slabyrinth` }),
    "project:rename": ({ name }) => {
      const p = open();
      const oldPath = p.path;
      p.name = name;
      p.path = p.path.replace(/[^\\]+\.slabyrinth$/, `${name}.slabyrinth`);
      recent = recent.map((x) => (x === oldPath ? p.path : x));
      emit("project:changed", { dirty: false, filePath: p.path, name });
    },
    "project:duplicate": ({ path }) => {
      const src = [...projects.values()].find((x) => x.path === path);
      if (!src) return fail("not_found", "Project not found.");
      const copy: FakeProject = structuredClone(src);
      copy.id = `${src.id}-copy-${Date.now().toString(36)}`;
      copy.name = `${src.name} (copy)`;
      copy.path = src.path.replace(/\.slabyrinth$/, " (copy).slabyrinth");
      projects.set(copy.id, copy);
      touch(copy);
      return { path: copy.path };
    },
    "project:trash": ({ path }) => {
      const p = [...projects.values()].find((x) => x.path === path);
      if (p) projects.delete(p.id);
      recent = recent.filter((x) => x !== path);
    },
    "project:revealInFolder": () => undefined,
    "project:close": () => {
      openId = null;
      return { closed: true };
    },
    "project:snapshot": () => snapshot(open()),
    "project:list": async () => {
      const rows = [...projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return Promise.all(
        rows.map(async (p) => {
          const e = listEntry(p);
          const plan = planAt(p, p.history.head);
          const png = plan ? await thumbnail(plan, `${p.id}@${p.history.head}`) : undefined;
          return png !== undefined ? { ...e, thumbnailPng: png } : e;
        }),
      );
    },
    "project:setUiState": ({ ui, pasteGuide, pngExport }) => {
      const p = open();
      const cur = uiState.get(p.id) ?? { ui: { tab: "map" }, pasteGuide: null, pngExport: null };
      if (pngExport !== undefined) cur.pngExport = structuredClone(pngExport);
      if (ui !== undefined) cur.ui = { ...cur.ui, ...ui };
      if (pasteGuide !== undefined) cur.pasteGuide = pasteGuide;
      uiState.set(p.id, cur);
    },
    "project:importPlan": () => null,
    "project:exportPlan": () => ({ path: `${open().path.replace(/\.slabyrinth$/, "")}.plan.json` }),

    "plan:applyOps": ({ label, ops }) => {
      const p = open();
      if (turn) return fail("busy", "Wait for the current reply to finish.");
      const plan = planAt(p, p.history.head);
      if (!plan) return fail("no_project", "There is no plan yet.");
      const r = applyLenient(plan, ops);
      if (!r.ok) return r;
      p.history = commitVersion(
        p.history,
        {
          plan: r.plan,
          author: "user",
          createdAt: new Date().toISOString(),
          summary: label,
          cause: { type: "ops", ops },
        },
        rules(),
      ).history;
      touch(p);
      planChanged(p);
      return { ...r, version: p.history.head };
    },
    "plan:undo": () => {
      const p = open();
      const r = undoHistory(p.history);
      if (!r.ok) return fail("validation", r.error.message);
      p.history = r.history;
      touch(p);
      planChanged(p);
      return { head: p.history.head };
    },
    "plan:redo": () => {
      const p = open();
      const r = redoHistory(p.history);
      if (!r.ok) return fail("validation", r.error.message);
      p.history = r.history;
      touch(p);
      planChanged(p);
      return { head: p.history.head };
    },
    "plan:restore": ({ version }) => {
      const p = open();
      const r = restoreHistory(p.history, version, new Date().toISOString(), rules());
      if (!r.ok) return fail("not_found", r.error.message);
      p.history = r.history;
      touch(p);
      planChanged(p);
      return { head: p.history.head };
    },
    "plan:getVersion": ({ version }) => {
      const plan = planAt(open(), version);
      if (!plan) return fail("not_found", `No version v${version}.`);
      return plan;
    },
    "plan:diff": ({ from, to }) => {
      const p = open();
      const b = planAt(p, to);
      if (!b) return fail("not_found", `No version v${to}.`);
      return diffPlans(planAt(p, from), b);
    },
    "plan:approve": ({ version }) => {
      const p = open();
      const plan = planAt(p, version);
      if (!plan) return fail("not_found", `No version v${version}.`);
      const warnings = plan.levels.flatMap((l) =>
        l.areas
          .filter((a) => a.key !== undefined && (a.notes ?? "") === "")
          .map((a) => `Room ${a.key ?? ""} ${a.name ?? ""} has no GM notes.`),
      );
      const r = approveHistory(p.history, version);
      if (!r.ok) return fail("not_found", r.error.message);
      p.history = r.history;
      touch(p);
      emit("project:changed", { dirty: false, filePath: p.path, name: p.name });
      return { approved: true, blocking: [], warnings };
    },
    "plan:editText": ({ id, set }) => {
      const p = open();
      if (turn) return fail("busy", "Wait for the current reply to finish.");
      const plan = planAt(p, p.history.head);
      if (!plan) return fail("no_project", "There is no plan yet.");
      const ops: PlanOp[] = [{ op: "update", id, set }];
      const r = applyLenient(plan, ops);
      if (!r.ok)
        return fail("validation", r.opErrors[0]?.message ?? r.issues[0]?.message ?? "Edit rejected.");
      const area = plan.levels.flatMap((l) => l.areas).find((a) => a.id === id);
      const what = Object.keys(set).includes("name") ? "name" : "notes";
      const label = area?.key !== undefined ? `You edited ${what} for ${area.key}` : `You edited ${id}`;
      // Merge edits of the same element within 2 minutes into one version (UX §6.8).
      const head = p.history.versions.find((v) => v.number === p.history.head);
      const latest = p.history.versions.at(-1);
      if (
        head &&
        latest === head &&
        head.author === "user" &&
        head.cause.type === "ops" &&
        head.cause.ops.every((o) => o.op === "update" && o.id === id) &&
        Date.now() - new Date(head.createdAt).getTime() < 120_000
      ) {
        const parentPlan = planAt(p, head.parentNumber);
        const prevOps = head.cause.ops;
        p.history = { ...p.history, head: head.parentNumber, versions: p.history.versions.slice(0, -1) };
        const merged = parentPlan ? applyOps(parentPlan, [...prevOps, ...ops], rules()) : r;
        if (merged.ok)
          p.history = commitVersion(
            p.history,
            {
              plan: merged.plan,
              author: "user",
              createdAt: new Date().toISOString(),
              summary: label,
              cause: { type: "ops", ops: [...prevOps, ...ops] },
            },
            rules(),
          ).history;
      } else {
        p.history = commitVersion(
          p.history,
          {
            plan: r.plan,
            author: "user",
            createdAt: new Date().toISOString(),
            summary: label,
            cause: { type: "ops", ops },
          },
          rules(),
        ).history;
      }
      touch(p);
      planChanged(p);
      return { head: p.history.head };
    },
    "brief:update": ({ set }) => {
      const p = open();
      const b = p.brief as Record<string, unknown>;
      for (const [k, v] of Object.entries(set)) {
        if (v === null || v === undefined) b[k] = undefined;
        else b[k] = { value: v, source: "user" };
      }
      touch(p);
      return structuredClone<DesignBrief>(p.brief);
    },

    "chat:send": (req) => startTurn(open(), req, false),
    "chat:estimate": ({ selection, intent }) => {
      const p = openId === null ? null : (projects.get(openId) ?? null);
      const sel = selection ?? p?.conversation.selection ?? settings.defaultSelection;
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
      if (turn?.id === turnId) turn.t.cancelled = true;
    },
    "chat:retry": ({ selection }) => {
      const p = open();
      if (!lastUser) {
        const lastU = [...p.conversation.items].reverse().find((i) => i.type === "user");
        if (lastU?.type !== "user") return fail("validation", "Nothing to retry.");
        lastUser = { text: lastU.text };
      }
      if (selection) p.conversation.selection = selection;
      return startTurn(
        p,
        { text: lastUser.text, ...(lastUser.selection ? { selection: lastUser.selection } : {}) },
        true,
      );
    },
    "chat:selectAlternative": () => undefined,
    "chat:continue": () => startTurn(open(), { text: "Continue." }, true),
    "chat:previewSwitch": ({ selection }) => {
      const p = open();
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
      const p = open();
      if (turn) return fail("busy", "Wait for the current reply to finish.");
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
      const p = open();
      p.conversation.selection = { ...p.conversation.selection, effort };
      return { selection: { ...p.conversation.selection } };
    },
    "chat:newConversation": () => snapshot(open()),

    "compile:estimate": () => {
      const plan = planAt(open(), open().history.head);
      const perLevel = (plan?.levels ?? []).map((l) => ({
        levelId: l.id,
        assets: Math.round(levelBytes(l) / 9),
        estimatedChunks: 1,
      }));
      return {
        perLevel,
        totalAssets: perLevel.reduce((s, l) => s + l.assets, 0),
        estimatedChunks: plan ? estimateSlabs(plan) : 0,
        diagnostics: [],
      };
    },
    "compile:run": async ({ version, options }) => {
      const p = open();
      const v = version ?? p.history.approvedVersion ?? p.history.head;
      const plan = planAt(p, v);
      if (!plan) return fail("not_found", "Nothing approved to build.");
      const stages = ["resolve", "realize", "chunk", "encode"] as const;
      for (const [i, stage] of stages.entries()) {
        for (let k = 1; k <= 3; k++) {
          emit("compile:progress", { stage, done: i * 3 + k, total: 12 });
          await sleep(170);
        }
      }
      const layout = options?.levelLayout ?? settings.talespire.levelLayout;
      const { bundle, record, slabText } = fakeCompile(
        plan,
        v,
        { ...options, levelLayout: layout },
        new Date().toISOString(),
        catalogState === "no_install" ? "builtin" : "install",
      );
      const prev = p.builds.at(-1);
      if (prev) {
        const old = new Map(prev.levels.flatMap((l) => l.chunks).map((c) => [c.id, c]));
        for (const l of record.levels)
          for (const c of l.chunks) {
            const o = old.get(c.id);
            if (!o) continue;
            c.changedSinceBuild = o.contentHash !== c.contentHash;
            if (!c.changedSinceBuild) {
              c.pasted = o.pasted;
              if (o.copiedAt !== undefined) c.copiedAt = o.copiedAt;
            }
          }
      }
      p.builds.push(record);
      p.slabs[record.id] = slabText;
      touch(p);
      return { ...bundle, buildId: record.id };
    },
    "compile:cancel": () => undefined,
    "build:setPasted": ({ buildId, chunkId, pasted }) => {
      const b = open().builds.find((x) => x.id === buildId);
      const cs = (b?.levels ?? []).flatMap((l) => l.chunks).filter((x) => x.id === chunkId);
      if (cs.length === 0) return fail("not_found", "Chunk not found.");
      for (const c of cs) {
        c.pasted = pasted;
        if (pasted && c.copiedAt === undefined) c.copiedAt = new Date().toISOString();
      }
    },
    "build:saveChunk": ({ chunkId }) => ({ path: `C:\\Users\\GM\\Documents\\Slabyrinth\\${chunkId}.txt` }),
    "export:savePng": async ({ suggestedName, files }) => {
      await sleep(300);
      return {
        paths: files.map(
          (f, i) =>
            `C:\\Users\\GM\\Pictures\\${files.length > 1 ? `${suggestedName}-${i + 1}` : suggestedName}.png`,
        ),
      };
    },
    "export:roomKeyMarkdown": ({ copyToClipboard }) => {
      const plan = planAt(open(), open().history.head);
      const md = (plan?.levels ?? [])
        .map(
          (l) =>
            `## ${l.name}\n\n${l.areas
              .filter((a) => a.key !== undefined)
              .map((a) => `### ${a.key ?? ""}. ${a.name ?? ""}\n\n${a.notes ?? ""}`)
              .join("\n\n")}`,
        )
        .join("\n\n");
      return copyToClipboard
        ? { markdown: md }
        : { markdown: md, path: "C:\\Users\\GM\\Documents\\room-key.md" };
    },
    "clipboard:writeText": ({ chunk }) => {
      markCopied(chunk);
    }, // the fake never touches the real clipboard

    "talespire:locate": async () => {
      await sleep(900);
      return {
        found:
          catalogState === "no_install"
            ? []
            : [{ path: "D:\\SteamLibrary\\steamapps\\common\\TaleSpire", source: "steam" }],
      };
    },
    "talespire:setPath": async ({ path }) => {
      await sleep(400);
      if (path === null) return { valid: false, reason: "No folder chosen." };
      catalogState = "fresh";
      settings.talespire.installPath = path;
      return { valid: true };
    },
    "catalog:status": () => ({
      state: catalogState,
      usingBuiltInOnly: catalogState === "no_install",
      generatedAt: catalogState === "no_install" ? null : new Date().toISOString(),
      assets: catalogState === "no_install" ? 125 : 4854,
      lastReport: null,
    }),
    "catalog:refresh": async () => {
      await sleep(1200);
      return {
        previousGeneratedAt: new Date(Date.now() - 86_400_000).toISOString(),
        sourceUsed: {},
        added: 42,
        removed: [],
        newlyDeprecated: [],
        geometryChanged: [],
        affectedPaletteRoles: [],
      };
    },
    "talespire:copyAndOpen": async ({ chunk }) => {
      await sleep(250);
      markCopied(chunk);
      if (catalogState === "no_install") return { copied: true, running: false, action: "not_installed" };
      const wasRunning = tsRunning;
      tsRunning = true;
      return { copied: true, running: wasRunning, action: wasRunning ? "focused" : "launched" };
    },
    "talespire:isRunning": () => ({ running: tsRunning }),
    "talespire:openUrl": () => {
      tsRunning = true;
      return { opened: true };
    },
    "palettes:list": () => [
      { id: "stone_dungeon", name: "Stone dungeon", source: "bundled", issues: 0 },
      { id: "cave", name: "Cave", source: "bundled", issues: 0 },
      { id: "forest", name: "Forest", source: "bundled", issues: 0 },
      { id: "town", name: "Town", source: "bundled", issues: 0 },
      { id: "tavern", name: "Tavern", source: "bundled", extends: "town", issues: 0 },
    ],
    "palettes:reload": () => undefined,
    "palettes:openFolder": () => undefined,
    // the fake main builds with the bundled palettes alone (no user files, no game catalog)
    "palettes:resolveData": () => resolvePalettesData(bundledPalettes()),
    "shell:openExternal": () => ({ opened: true }),

    "updates:status": () => updateStatus(),
    "updates:check": async () => {
      await sleep(600);
      lastCheckedAt = new Date().toISOString();
      return updateStatus();
    },
    "updates:skip": ({ version }) => {
      settings = { ...settings, updates: { ...settings.updates, skippedVersion: version } };
      return updateStatus();
    },
  };

  // Startup warning, as main sends it after the first catalog check.
  if (scenario.nots === true) {
    setTimeout(() => {
      emit("catalog:warning", { kind: "no_install", message: "TaleSpire wasn't found." });
    }, 600 * speed);
  }

  const api = {
    async invoke<C extends keyof IpcRequests>(
      channel: C,
      req: IpcRequests[C]["req"],
    ): Promise<Result<IpcRequests[C]["res"]>> {
      await sleep(30);
      try {
        const h = handlers[channel] as (
          r: IpcRequests[C]["req"],
        ) => IpcRequests[C]["res"] | Promise<IpcRequests[C]["res"]>;
        const value = await h(req);
        return { ok: true, value };
      } catch (e) {
        if (e instanceof FakeFailure) return { ok: false, error: e.appError };
        return {
          ok: false,
          error: { code: "internal", message: e instanceof Error ? e.message : String(e) },
        };
      }
    },
    on<C extends keyof IpcEvents>(channel: C, listener: (payload: IpcEvents[C]) => void): () => void {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      const l = listener as (p: unknown) => void;
      set.add(l);
      return () => set.delete(l);
    },
    send(): void {
      // render:imageResult — nothing consumes it in the fake.
    },
    emit,
    projects,
  };
  return api;
}
