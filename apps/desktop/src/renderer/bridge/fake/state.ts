/**
 * The fake main's state, one record per bridge (never module-level): the projects, the open one, the running turn,
 * settings, the key, TaleSpire and the catalog, and the helpers every handler group shares (the open project, a
 * version's plan, the snapshot, the plan-changed event). The handler groups in handlers/ read and change it.
 */
import { reconstruct } from "@slabyrinth/core";
import type { MapPlan } from "@slabyrinth/core";
import { countPlanRooms } from "@slabyrinth/core";
import type { AppError, IpcEvents, IpcRequests, ProjectSnapshot } from "../../../shared/ipc";
import type { AppSettings, Phase, ProjectFile } from "../../../shared/project";
import type { Usage } from "../../../main/agent/provider/types";
import type { FakeTurn } from "./engine";
import { makeFixtureProjects, type FakeProject } from "./fixtures";
import { fakeRules as rules } from "./rules";

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

export class FakeFailure extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message);
  }
}

/** Rejects the request with an AppError (the bridge returns it as `{ ok: false }`). */
export const fail = (code: AppError["code"], message: string): never => {
  throw new FakeFailure({ code, message });
};

export type Handlers = {
  [C in keyof IpcRequests]: (
    req: IpcRequests[C]["req"],
  ) => IpcRequests[C]["res"] | Promise<IpcRequests[C]["res"]>;
};

/** A group of handlers: the channels it answers. */
export type HandlerGroup<K extends keyof IpcRequests> = Pick<Handlers, K>;

const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** The recent-projects list keeps this many paths. */
const RECENT_LIMIT = 10;

/** The release the "update" scenario offers. */
const FAKE_UPDATE = {
  version: "0.2.0",
  tag: "v0.2.0",
  publishedAt: "2026-12-01T12:00:00Z",
  notes: "### Added\n- Stamps for repeated rooms\n\n### Fixed\n- Stairs against walls",
  url: "https://github.com/mwaboff/slabyrinth/releases/tag/v0.2.0",
};

interface UiState {
  ui: ProjectFile["ui"];
  pasteGuide: NonNullable<ProjectFile["pasteGuide"]> | null;
  pngExport: NonNullable<ProjectFile["pngExport"]> | null;
}

export class FakeState {
  readonly scenario: FakeScenario;
  readonly speed: number;
  readonly listeners = new Map<string, Set<(p: unknown) => void>>();
  readonly projects = new Map<string, FakeProject>();
  recent: string[];
  openId: string | null = null;
  turn: { id: string; t: FakeTurn } | null = null;
  untitled = 0;
  lastUser: { text: string; selection?: IpcRequests["chat:send"]["req"]["selection"] } | null = null;
  tsRunning = false;
  hasKey: boolean;
  keyHint = "sk-ant-…a1B2";
  lastCheckedAt: string | null = null;
  readonly uiState = new Map<string, UiState>();
  catalogState: "no_install" | "fresh";
  settings: AppSettings;

  constructor(opts: FakeOptions) {
    const scenario = opts.scenario ?? {};
    this.scenario = scenario;
    this.speed = opts.speed ?? 1;
    if (scenario.empty !== true) for (const p of makeFixtureProjects()) this.projects.set(p.id, p);
    this.recent = [...this.projects.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((p) => p.path);
    this.hasKey = scenario.nokey !== true;
    this.catalogState = scenario.nots === true ? "no_install" : "fresh";
    this.settings = initialSettings(scenario, this.recent);
  }

  readonly sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms * this.speed));

  readonly emit = <C extends keyof IpcEvents>(channel: C, payload: IpcEvents[C]): void => {
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const l of [...set]) l(payload);
  };

  /** The open project; rejects with no_project when none is open. */
  open(): FakeProject {
    const p = this.openId === null ? undefined : this.projects.get(this.openId);
    if (!p) return fail("no_project", "No project is open.");
    return p;
  }

  /** The plan at version n (null for 0 or a version that does not replay). */
  planAt(p: FakeProject, n: number): MapPlan | null {
    if (n === 0) return null;
    const r = reconstruct(p.history, n, rules());
    return r.ok ? r.plan : null;
  }

  phaseOf(p: FakeProject): Phase {
    return p.history.approvedVersion !== null ? "build" : p.history.head > 0 ? "plan" : "brief";
  }

  /** Marks the project changed now and moves it to the top of the recent list. */
  touch(p: FakeProject): void {
    p.updatedAt = new Date().toISOString();
    p.lastActivityAt = p.updatedAt;
    this.recent = [p.path, ...this.recent.filter((x) => x !== p.path)].slice(0, RECENT_LIMIT);
  }

  snapshot(p: FakeProject): ProjectSnapshot {
    const ui = this.uiState.get(p.id);
    return {
      projectId: p.id,
      name: p.name,
      filePath: p.path,
      dirty: false,
      plan: this.planAt(p, p.history.head),
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
        phase: this.phaseOf(p),
        items: structuredClone(p.conversation.items),
        meta: structuredClone(p.conversation.meta),
        totals: structuredClone(p.conversation.totals),
        toolMode: p.conversation.toolMode,
      },
      busy: this.turn ? { turnId: this.turn.id } : null,
      ui: structuredClone(ui?.ui ?? { tab: "map" }),
      pasteGuide: ui?.pasteGuide ?? null,
      pngExport: ui?.pngExport ?? null,
    };
  }

  /** Sends "plan:changed" for the head version, as main does after each commit. */
  planChanged(p: FakeProject): void {
    const v = p.history.versions.find((x) => x.number === p.history.head);
    if (!v) return;
    const { cause, ...rest } = v;
    delete rest.snapshot;
    this.emit("plan:changed", {
      head: p.history.head,
      plan: this.planAt(p, p.history.head),
      version: { ...rest, causeType: cause.type },
    });
  }

  /** Marks a chunk of the open project's build as copied now. */
  markCopied(chunk: { buildId: string; chunkId: string } | undefined): void {
    if (!chunk || this.openId === null) return;
    const b = this.projects.get(this.openId)?.builds.find((x) => x.id === chunk.buildId);
    for (const l of b?.levels ?? [])
      for (const c of l.chunks) if (c.id === chunk.chunkId) c.copiedAt = new Date().toISOString();
  }

  listEntry(p: FakeProject): IpcRequests["project:list"]["res"][number] {
    const plan = this.planAt(p, p.history.head);
    return {
      path: p.path,
      name: p.name,
      updatedAt: p.updatedAt,
      exists: true,
      levels: plan?.levels.length ?? 0,
      rooms: countPlanRooms(plan),
      phase: this.phaseOf(p),
    };
  }

  updateStatus(): IpcRequests["updates:status"]["res"] {
    const update = this.scenario.update === true ? { ...FAKE_UPDATE } : null;
    return {
      state: update ? "available" : this.lastCheckedAt !== null ? "up_to_date" : "idle",
      currentVersion: "0.1.0",
      lastCheckedAt: this.lastCheckedAt,
      update,
      skipped: update !== null && this.settings.updates.skippedVersion === update.version,
    };
  }
}

function initialSettings(scenario: FakeScenario, recent: string[]): AppSettings {
  return {
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
}
