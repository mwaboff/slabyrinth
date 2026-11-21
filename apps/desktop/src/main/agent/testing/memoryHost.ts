/**
 * In-memory EngineHost for tests and the headless eval harness. Implements the WP5 port with core's history
 * functions; nothing touches disk, Electron or the renderer.
 */
import { randomUUID } from "node:crypto";
import { commitVersion, createHistory, moveHeadBack, reconstruct } from "@slabyrinth/core/history";
import { BUNDLED_PALETTES, bundledPalettes, parsePalette } from "@slabyrinth/core/palette";
import { planRules } from "@slabyrinth/core/resolve";
import type { CompileEstimate, Palette, PaletteCatalog } from "@slabyrinth/core/contracts/compiler";
import type { DesignBrief, LevelId, MapPlan } from "@slabyrinth/core/contracts/plan";
import type { ChatEvent } from "../../../shared/ipc";
import type { AppSettings, ChatMessageMeta, Conversation, ProjectFile } from "../../../shared/project";
import { PROJECT_FORMAT, PROJECT_FORMAT_VERSION } from "../../../shared/project";
import type { CommitVersionInput, EngineHost, EngineLogger, ImageRequest } from "../../ports/engine";
import { ZERO_USAGE, addCost, addUsage } from "../cost";
import type { ChatItem, Cost, ModelSelection, Usage } from "../provider/types";

export const DEFAULT_SELECTION: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-opus-5-5",
  effort: "medium",
};

export function defaultSettings(): AppSettings {
  return {
    schema: "slabyrinth/settings@1",
    defaultSelection: DEFAULT_SELECTION,
    providers: { anthropic: { enabled: true }, lmstudio: { enabled: false } },
    smartEffort: true,
    showReasoning: false,
    spending: { perActionWarnUsd: 1, perProjectWarnUsd: 10, allTime: { usage: ZERO_USAGE, cost: null } },
    talespire: { installPath: null, lastScanAt: null, levelLayout: "stacked", alignmentMarkers: true },
    projects: { folder: "", recent: [] },
    ui: { theme: "dark", mapThemeId: "auto", gridVisible: true, onLaunch: "home" },
    suppressAssetWarning: false,
    defaultSystem: null,
    setupCompleted: true,
    updates: { autoCheck: true },
  };
}

export function newProject(
  selection: ModelSelection = DEFAULT_SELECTION,
  defaults?: Pick<Conversation, "systemPromptVersion" | "toolsVersion" | "imageToolEnabled" | "toolMode">,
): ProjectFile {
  const now = new Date(0).toISOString();
  const conv: Conversation = {
    id: "conv1",
    createdAt: now,
    selection,
    selectionLog: [],
    systemPromptVersion: defaults?.systemPromptVersion ?? "sp-1.0.0",
    toolsVersion: defaults?.toolsVersion ?? "tools-1.0.0",
    imageToolEnabled: defaults?.imageToolEnabled ?? true,
    toolMode: defaults?.toolMode ?? "native",
    items: [],
    meta: {},
    modelSeen: { head: 0, briefHash: "" },
    totals: { usage: ZERO_USAGE, cost: null, turns: 0 },
    compactions: [],
    archived: false,
  };
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    appVersion: "test",
    id: randomUUID(),
    name: "Test map",
    createdAt: now,
    updatedAt: now,
    brief: {},
    plan: null,
    history: createHistory(),
    conversations: [conv],
    activeConversationId: conv.id,
    builds: [],
    spend: { usage: ZERO_USAGE, cost: null },
    blobs: {},
    stamps: {},
    ui: { tab: "map" },
  };
}

export interface MemoryHostOptions {
  apiKey?: string | null;
  settings?: AppSettings;
  palettes?: Palette[];
  /** The palettes builds compile with (default: the bundled palettes alone). */
  buildPalettes?: PaletteCatalog;
  estimate?: (
    plan: MapPlan,
    levels: LevelId[] | undefined,
    signal: AbortSignal,
  ) => CompileEstimate | null | Promise<CompileEstimate | null>;
  image?: (req: ImageRequest) => string;
}

export class MemoryHost implements EngineHost {
  project: ProjectFile | null;
  readonly events: ChatEvent[] = [];
  busy: { turnId: string } | null = null;
  flushes = 0;
  spend: { usage: Usage; cost: Cost | null } = { usage: ZERO_USAGE, cost: null };
  readonly logger: EngineLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  private readonly opts: MemoryHostOptions;

  constructor(project: ProjectFile | null = newProject(), opts: MemoryHostOptions = {}) {
    this.project = project;
    this.opts = opts;
  }

  private p(): ProjectFile {
    if (!this.project) throw new Error("no project");
    return this.project;
  }

  conv(id?: string): Conversation {
    const p = this.p();
    const c = p.conversations.find((x) => x.id === (id ?? p.activeConversationId));
    if (!c) throw new Error("no conversation");
    return c;
  }

  getProject(): Readonly<ProjectFile> | null {
    return this.project;
  }

  getPlan(version?: number): MapPlan | null {
    const p = this.p();
    const n = version ?? p.history.head;
    if (n === 0) return null;
    const r = reconstruct(p.history, n, planRules(this.getBuildPalettes()));
    return r.ok ? r.plan : null;
  }

  commitVersion(input: CommitVersionInput): { version: number; plan: MapPlan } {
    const p = this.p();
    if (input.baseVersion !== undefined && input.baseVersion !== p.history.head)
      throw new Error("busy: stale base version");
    const c: Parameters<typeof commitVersion>[1] = {
      plan: input.plan,
      author: input.author,
      createdAt: new Date().toISOString(),
      summary: input.summary,
      cause: input.cause,
    };
    if (input.changeSummary) c.changeSummary = input.changeSummary;
    if (input.messageId !== undefined) c.messageId = input.messageId;
    if (input.cost !== undefined) c.cost = input.cost;
    const r = commitVersion(p.history, c, planRules(this.getBuildPalettes()));
    p.history = r.history;
    p.plan = input.plan;
    return { version: r.version.number, plan: input.plan };
  }

  moveHead(version: number): { head: number } {
    const p = this.p();
    const r = moveHeadBack(p.history, version);
    if (!r.ok) throw new Error(`moveHead: ${r.error.message}`);
    p.history = r.history;
    p.plan = this.getPlan(version);
    return { head: version };
  }

  appendItems(conversationId: string, items: ChatItem[], meta?: Record<string, ChatMessageMeta>): void {
    const c = this.conv(conversationId);
    c.items.push(...structuredClone(items));
    if (meta) Object.assign(c.meta, structuredClone(meta));
  }

  updateConversation(conversationId: string, mutate: (c: Conversation) => void): void {
    mutate(this.conv(conversationId));
  }

  setBrief(brief: DesignBrief): void {
    this.p().brief = structuredClone(brief);
  }

  setBusy(turn: { turnId: string } | null): void {
    this.busy = turn;
  }

  addSpend(usage: Usage, cost: Cost | null): void {
    this.spend = { usage: addUsage(this.spend.usage, usage), cost: addCost(this.spend.cost, cost) };
  }

  emit(event: ChatEvent): void {
    this.events.push(event);
  }

  requestImage(req: ImageRequest): Promise<string> {
    return Promise.resolve(this.opts.image?.(req) ?? "iVBORw0KGgo=");
  }

  getApiKey(): Promise<string | null> {
    return Promise.resolve(this.opts.apiKey === undefined ? "sk-test" : this.opts.apiKey);
  }

  getSettings(): AppSettings {
    return this.opts.settings ?? defaultSettings();
  }

  async estimateCompile(
    plan: MapPlan,
    levels: LevelId[] | undefined,
    signal: AbortSignal,
  ): Promise<CompileEstimate> {
    const est = this.opts.estimate
      ? await this.opts.estimate(plan, levels, signal)
      : {
          perLevel: plan.levels.map((l) => ({ levelId: l.id, assets: 10, estimatedChunks: 1 })),
          totalAssets: 10 * plan.levels.length,
          estimatedChunks: 1,
          diagnostics: [],
        };
    if (est === null) throw new Error("no compiler");
    return est;
  }

  getAssetCatalog(): null {
    return null;
  }

  getPalettes(): Palette[] {
    return (
      this.opts.palettes ??
      BUNDLED_PALETTES.flatMap((p) => {
        const r = parsePalette(p);
        return r.ok ? [r.value] : [];
      })
    );
  }

  getBuildPalettes(): PaletteCatalog {
    return this.opts.buildPalettes ?? bundledPalettes();
  }

  flush(): Promise<void> {
    this.flushes++;
    return Promise.resolve();
  }

  eventsOf<T extends ChatEvent["type"]>(type: T): Array<Extract<ChatEvent, { type: T }>> {
    return this.events.filter((e): e is Extract<ChatEvent, { type: T }> => e.type === type);
  }
}
