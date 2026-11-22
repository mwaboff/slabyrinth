/**
 * ENGINE PORT — the seam between the desktop shell (main's services) and the ConversationEngine (main/agent)
 * (architecture §3.2, §8.2). The engine imports ONLY this file (plus the contracts); the shell implements
 * `EngineHost` (ProjectService and friends) and constructs the engine with it.
 *
 * Wiring: `apps/desktop/src/main/agent/index.ts` exports `createConversationEngine: EngineFactory`, which
 * main/engineWiring.ts builds the one engine with (test runs register a scripted provider in it instead of Anthropic).
 *
 * Rules for the engine:
 *  - Mutate project state ONLY through the host (commitVersion, appendItems, updateConversation,
 *    setBrief). The host autosaves (debounced 1 s); call `flush()` at the end of every turn.
 *  - Stream UI events with `emit` (ChatEvent from shared/ipc.ts; every event carries turnId).
 *  - Call `setBusy({turnId})` when a turn starts and `setBusy(null)` when it ends; while busy the
 *    host refuses UI plan edits with code "busy".
 *  - Never log or emit API keys or full prompts. `getApiKey` is main-only.
 *  - Throw `EnginePortError` (or a ProviderError carrying `.info`) for user-facing failures; any
 *    other exception becomes an "internal" IPC error.
 */
import type { DesignBrief, LevelId, MapPlan } from "@slabyrinth/core/contracts/plan";
import type { PlanVersion, VersionAuthor } from "@slabyrinth/core/contracts/ops";
import type {
  AssetCatalog,
  CompileEstimate,
  Palette,
  PaletteCatalog,
} from "@slabyrinth/core/contracts/compiler";
import type {
  ChatItem,
  Cost,
  EffortLevel,
  ModelDescriptor,
  ModelSelection,
  ProviderErrorInfo,
  ProviderId,
  ProviderInfo,
  SwitchImpact,
  Usage,
} from "../agent/provider/types";
import type { AppError, ChatEvent, IpcEvents, IpcRequests } from "../../shared/ipc";
import type { AppSettings, ChatMessageMeta, Conversation, ProjectFile } from "../../shared/project";

export interface EngineLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface CommitVersionInput {
  /** The new plan (already validated by core applyOps / create_plan). */
  plan: MapPlan;
  author: VersionAuthor;
  summary: string;
  /** ≤ 6 bullets for the Plan update card. */
  changeSummary?: string[];
  cause: PlanVersion["cause"];
  messageId?: string;
  cost?: { currency: "USD"; amount: number } | null;
  /** Optimistic concurrency: when set, must equal the current head number or the commit is refused ("busy"). */
  baseVersion?: number;
}

/** Image bridge request (architecture §5.5 step 4): the renderer rasterizes and replies. */
export type ImageRequest = Omit<IpcEvents["render:requestImage"], "requestId">;

/** Implemented by the shell (ProjectService + friends). All methods act on the currently open project. */
export interface EngineHost {
  /** Current project; treat as read-only (mutate through the methods below). null = no project open. */
  getProject(): Readonly<ProjectFile> | null;
  /** Plan at a version (default head). null when the project has no plan yet. */
  getPlan(version?: number): MapPlan | null;
  /** Appends a version and moves head to it; emits plan:changed; schedules autosave. */
  commitVersion(input: CommitVersionInput): { version: number; plan: MapPlan };
  /**
   * Moves head back to `version` (an ancestor of head) without creating a version: an undo of every
   * version in between, recorded in `undone` (Retry, architecture §3.2). Emits plan:changed.
   */
  moveHead(version: number): { head: number };
  /** Appends items to a conversation's transcript (append-only) and optional per-item meta. */
  appendItems(conversationId: string, items: ChatItem[], meta?: Record<string, ChatMessageMeta>): void;
  /** Arbitrary update of a conversation (meta, totals, modelSeen, pendingQuestions, selection…). */
  updateConversation(conversationId: string, mutate: (c: Conversation) => void): void;
  setBrief(brief: DesignBrief): void;
  /** Marks a turn as running (UI plan edits refused) or finished. */
  setBusy(turn: { turnId: string } | null): void;
  /** Adds to project spend and the all-time total in settings. */
  addSpend(usage: Usage, cost: Cost | null): void;
  /** Sends a chat event to the renderer. */
  emit(event: ChatEvent): void;
  /** Asks the renderer to rasterize a level (view_map_image). Resolves with PNG base64. */
  requestImage(req: ImageRequest, signal?: AbortSignal): Promise<string>;
  /** MAIN ONLY: decrypted API key (null if none). Never log, emit or persist it. */
  getApiKey(providerId: ProviderId): Promise<string | null>;
  getSettings(): AppSettings;
  /**
   * Compile estimate for compile_preview. `signal`: the turn's; when it aborts (Stop) the estimate is abandoned and its
   * worker ended. The host also gives every estimate a deadline, so a looping compile can never hold a turn.
   */
  estimateCompile(
    plan: MapPlan,
    levels: LevelId[] | undefined,
    signal: AbortSignal,
  ): Promise<CompileEstimate>;
  /** Cached asset catalog from the user's install (null = built-in asset set only). */
  getAssetCatalog(): AssetCatalog | null;
  /** Palettes visible to the app (bundled + user). */
  getPalettes(): Palette[];
  /**
   * The palettes builds compile with (bundled + user + the scanned game assets). Every plan the engine resolves,
   * checks or reviews is resolved against these, so the model sees the map the build produces.
   */
  getBuildPalettes(): PaletteCatalog;
  /** Writes pending changes now (end of turn). */
  flush(): Promise<void>;
  readonly logger: EngineLogger;
}

/** Implemented by main/agent. Methods mirror the chat:/providers:/models: IPC channels one to one. */
export interface ConversationEngine {
  /** Frozen per-conversation settings for a NEW conversation (system prompt/tools versions, tool mode). */
  conversationDefaults(selection: ModelSelection): {
    systemPromptVersion: string;
    toolsVersion: string;
    imageToolEnabled: boolean;
    toolMode: "native" | "json" | "none";
  };
  send(req: IpcRequests["chat:send"]["req"]): Promise<{ turnId: string }>;
  estimate(req: IpcRequests["chat:estimate"]["req"]): Promise<IpcRequests["chat:estimate"]["res"]>;
  cancel(turnId: string): Promise<void>;
  retry(req: IpcRequests["chat:retry"]["req"]): Promise<{ turnId: string }>;
  continue(): Promise<{ turnId: string }>;
  selectAlternative(req: IpcRequests["chat:selectAlternative"]["req"]): Promise<void>;
  previewSwitch(selection: ModelSelection): Promise<SwitchImpact>;
  setSelection(selection: ModelSelection): Promise<{ selection: ModelSelection }>;
  setEffort(effort: EffortLevel | null): Promise<{ selection: ModelSelection }>;
  listProviders(): Promise<Array<ProviderInfo & { enabled: boolean }>>;
  checkProvider(providerId: ProviderId): Promise<{ ok: true } | { ok: false; error: ProviderErrorInfo }>;
  listModels(providerId: ProviderId, refresh: boolean): Promise<ModelDescriptor[]>;
  /** The open project is about to close or switch: cancel running turns, flush. */
  onProjectClosing(): Promise<void>;
  /** A project was opened or created (resume bookkeeping, e.g. interrupted-turn detection). */
  onProjectOpened(): void;
  dispose(): Promise<void>;
}

export type EngineFactory = (host: EngineHost) => ConversationEngine;

/** Throw from engine methods to return a specific AppError to the renderer. */
export class EnginePortError extends Error {
  readonly error: AppError;
  constructor(error: AppError) {
    super(error.message);
    this.name = "EnginePortError";
    this.error = error;
  }
}
