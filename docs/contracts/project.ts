/**
 * Slabyrinth — project file (.slabyrinth), resumability, and app settings.
 * NORMATIVE CONTRACT. Copy verbatim into apps/desktop/src/shared/project.ts.
 *
 * A project file is SELF-SUFFICIENT for resuming: brief, every plan version + head/undone/approved pointers,
 * the provider-neutral transcript (with opaque per-provider replay payloads), model/effort selection, build
 * records, usage/cost totals. Never contains secrets. Slab strings are NOT stored (recompiled; deterministic).
 */
import type { DesignBrief, MapPlan, LevelId } from "./plan";
import type { PlanHistory } from "./ops";
import type { ChatItem, EffortLevel, ModelSelection, ProviderId, Usage, Cost } from "./provider";
import type { ChunkOptions, ExportBundle, StampAsset } from "./compiler";

/** Bump the integer on any breaking change; core `migrateProject(json)` upgrades step by step (1→2→…). */
export const PROJECT_FORMAT = "slabyrinth/project@1" as const;
export const PROJECT_FORMAT_VERSION = 1 as const;

/** Derived UI phase (UX §2.1) — computed, never stored: brief (no version) · plan · build (approved exists). */
export type Phase = "brief" | "plan" | "build";

/** Per assistant message, for the meta line, alternatives (Retry) and status. Keyed by ChatItem id. */
export interface ChatMessageMeta {
  selection: ModelSelection;          // what was requested
  servedBy: { providerId: ProviderId; modelId: string };
  effortUsed: EffortLevel | null;     // after Smart effort / fallback snapping
  durationMs: number;
  usage: Usage;
  cost: Cost | null;
  status: "complete" | "stopped" | "refused" | "truncated" | "error";
  errorCode?: string;
  /** Plan version(s) this turn produced (Plan update cards). */
  versions: number[];
  /**
   * Retry alternatives (UX §5.6): earlier attempts of the same turn, display-only. Their items are NOT part of
   * the active transcript (they were the tail when retried, so dropping them keeps the API prefix intact).
   */
  alternatives?: Array<{ items: ChatItem[]; meta: Omit<ChatMessageMeta, "alternatives"> }>;
  activeAlternative?: number;
}

export interface Conversation {
  id: string;
  createdAt: string;
  /** Current selection; next message uses it. Every change is logged and posted as a system line. */
  selection: ModelSelection;
  selectionLog: Array<{ at: string; afterItemId: string | null; selection: ModelSelection }>;
  /** Frozen at conversation start (prompt-cache & preserved-thinking safety); new versions apply to NEW conversations. */
  systemPromptVersion: string;        // e.g. "sp-1.0.0"
  toolsVersion: string;               // e.g. "tools-1.0.0"
  imageToolEnabled: boolean;
  toolMode: "native" | "json" | "none";
  /** Active, append-only transcript (provider-neutral; assistant items carry opaque providerState). */
  items: ChatItem[];
  meta: Record<string, ChatMessageMeta>;
  /**
   * What the model last saw (plan head number + brief hash + approved version). Before each user turn the engine
   * compares this with the project and, if different (UI edits, undo, restore, brief edits, edits made while the
   * app was closed), appends a "plan_changed"/"brief_changed" context item with a diff summary + fresh outline.
   */
  modelSeen: { head: number; briefHash: string };
  /** ask_questions call awaiting the GM's answers (resume restores the Question card). */
  pendingQuestions?: { callId: string; itemId: string };
  totals: { usage: Usage; cost: Cost | null; turns: number };
  compactions: Array<{ at: string; afterItemId: string; kind: "provider" | "client_summary" }>;
  /** Read-only once the user starts a new conversation on the same map. */
  archived: boolean;
}

/** Build metadata (UX §16 builds[]); slab strings are recompiled on demand (deterministic). */
export interface BuildRecord {
  id: string;
  versionNumber: number;
  createdAt: string;
  /** Catalog generatedAt (or "builtin"); orientation/palette hashes make builds stale when assets data changes. */
  catalogVersion: string;
  assetSource: "install" | "builtin";
  settings: {
    stacking: NonNullable<ChunkOptions["levelLayout"]>;
    gapSq: number;
    markers: NonNullable<ChunkOptions["alignment"]>;
    /** ChunkOptions.grouping used (absent in builds saved before 2026-11-18 = "fewest"). */
    grouping?: NonNullable<ChunkOptions["grouping"]>;
    /** ChunkOptions.fill used (absent = the compiler default). */
    fill?: number;
    /** ChunkOptions.levels when the build covered only some levels (absent = every level). */
    levels?: LevelId[];
    /** ChunkOptions.tileCells used (absent = the compiler default). */
    tileCells?: number;
    copyFormat: "plain" | "fenced";
    orientationHash: string;
    paletteHash: string;
  };
  levels: Array<{
    levelId: LevelId;
    pasteOrder: number;
    placement: { kind: "ground" | "storeys-up" | "side-by-side"; storeys?: number; offsetSq?: number };
    /** Chunks are recorded once, under their lowest level; a chunk may span several levels (levelIds). */
    chunks: Array<{
      id: string;
      /** Every level the chunk contains (SlabChunk.levelIds), lowest first. Absent in builds saved before 2026-11-18. */
      levelIds?: LevelId[];
      index: number;
      /** 1-based step across the whole paste guide. */
      globalStep: number;
      label: string;
      region: { x0: number; y0: number; x1: number; y1: number };
      sizeBytes: number;           // gzip bytes
      limitBytes: number;          // 30720
      contentHash: string;
      offset: { x: number; y: number; z: number };
      copiedAt?: string;
      pasted: boolean;
      /** Set on rebuild: content hash differs from the previous build's chunk with the same region. */
      changedSinceBuild?: boolean;
    }>;
  }>;
  substitutions: Array<{ role: string; wanted: string; used: string | null; count: number }>;
  /** Features/roles with no asset at all (dropped). */
  unmatchedAssets: Array<{ role: string; count: number }>;
  diagnosticsSummary: { errors: number; warnings: number };
  /**
   * Where the cursor goes when the build is pasted from beside the map (ExportBundle.pasteAnchor), so the paste steps
   * read the same after a restart. Absent for a build pasted the plain way, and in builds saved before 2026-11-22.
   */
  pasteAnchor?: NonNullable<ExportBundle["pasteAnchor"]>;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  formatVersion: number;              // PROJECT_FORMAT_VERSION at write time
  appVersion: string;
  id: string;                         // uuid; detects duplicates/copies on open
  name: string;
  createdAt: string;
  updatedAt: string;
  brief: DesignBrief;
  /** Head plan, denormalized for fast open; must equal reconstruct(history, head) — verified on open. */
  plan: MapPlan | null;
  history: PlanHistory;
  conversations: Conversation[];
  activeConversationId: string;
  builds: BuildRecord[];
  /** Project spend (all conversations); global totals live in settings. */
  spend: { usage: Usage; cost: Cost | null };
  /** Content-addressed blobs (user-attached images, rendered map images sent to the model). key = sha256 hex. */
  blobs: Record<string, { mediaType: string; dataBase64: string }>;
  /** RESERVED for imported slab stamps (§9.2). v1 writes {} and preserves unknown entries on save. */
  stamps: Record<string, StampAsset>;
/** Resume state (UX §16 ui / §8.9): everything needed so reopening "feels like you never left". */
  ui: {
    tab: "map" | "build";
    levelId?: string;
    zoom?: number;
    pan?: [number, number];
    roomKeyScroll?: number;
    briefExpanded?: boolean;
    layers?: Record<string, boolean>;
    chatWidth?: number;
    composerDraft?: { text: string; references: Array<{ type: "room" | "feature" | "area" | "level" | "opening" | "link"; id: string; levelId: string }> };
    lastActivityAt?: string;
  };
  /** Paste guide progress (resumes at the right step). */
  pasteGuide?: { buildId: string; currentStep: number };
  /** Last-used PNG export options (UX §16 pngExport). */
  pngExport?: { scope: "level" | "all"; version?: number; style: string; pxPerSquare: number; grid: boolean; numbers: boolean; names: boolean; gmLayer: boolean; keyPanel?: boolean };
  /** Small PNG (base64) of the last-viewed level for Home; regenerated when missing. */
  thumbnail?: { levelId: string; version: number; pngBase64: string };
  /** Unknown top-level keys from NEWER minor writers are preserved verbatim on save. */
  [extension: `x-${string}`]: unknown;
}

// ───────────────────────────── settings (userData/settings.json) ─────────────────────────────

export interface ProviderSettings {
  enabled: boolean;
  /** Non-secret. Keys live in SecretStore (safeStorage), never here or in project files. */
  baseUrl?: string;
  /** Provider-specific, validated by the provider's own schema (e.g. anthropic: { cacheTtl: "5m" | "1h" }). */
  options?: Record<string, unknown>;
  /** Default model/effort for new projects with this provider. */
  defaultSelection?: ModelSelection;
}

export interface AppSettings {
  schema: "slabyrinth/settings@1";
  /** Default for NEW projects. Ships as { anthropic, claude-opus-5-5, medium }. */
  defaultSelection: ModelSelection;
  providers: Record<ProviderId, ProviderSettings>;
  /** UX §5.8 Smart effort: chat-only turns use at most "medium". Default true. */
  smartEffort: boolean;
  showReasoning: boolean;
  spending: { perActionWarnUsd: number | null; perProjectWarnUsd: number | null; allTime: { usage: Usage; cost: Cost | null } };
  talespire: {
    installPath: string | null;
    lastScanAt: string | null;
    levelLayout: "stacked" | "side_by_side";
    alignmentMarkers: boolean;
    /** The Symbiotes folder chosen by hand for the add-on (addon:chooseFolder); absent or null = found automatically. Main-owned. */
    symbiotesFolder?: string | null;
    /** The bundled add-on version whose update dialog the user dismissed ("don't ask again"). Main-owned. */
    addonPromptDismissed?: string;
  };
  projects: { folder: string; recent: string[] };   // folder default: Documents/Slabyrinth; recent ≤ 10 absolute paths
  /** App theme. Default "system" (owner, 2026-11-22); map theme follows unless overridden. */
  ui: { theme: "dark" | "light" | "system"; mapThemeId: string | "auto"; gridVisible: boolean; onLaunch: "home" | "last_project" };
  /** Built-in-asset-set banner: "Don't remind me". */
  suppressAssetWarning: boolean;
  /**
   * Default game system (UX setup step 3), written into new projects' briefs as a user value.
   * null = not chosen yet. `otherName`: free text when system is "other" (e.g. "Pathfinder 2e").
   */
  defaultSystem: { system: "daggerheart" | "dnd5e" | "other"; otherName?: string } | null;
  setupCompleted: boolean;
  /**
   * Update notice (decisions.md "Update notice"): one anonymous request to GitHub's latest-release API at most
   * once a day in packaged builds, when autoCheck is on (default true). skippedVersion ("0.2.0") and
   * lastCheckedAt (ISO) are main-owned.
   */
  updates: { autoCheck: boolean; skippedVersion?: string; lastCheckedAt?: string };
  /**
   * The largest map the model may make and the app validates and builds (core plan/sizeTiers.ts). Absent = "standard"
   * (320 cells a side). The larger tiers are experimental: slower edits and builds, more memory, more slabs. A project
   * whose plan is larger than this is still opened and edited at the tier it needs (smallestTierFor).
   */
  mapSize?: "standard" | "large-512" | "large-768" | "large-1024";
  /**
   * How far the model may go on its own in one turn. Absent = the defaults (4, true, 6). Nothing here changes what the
   * model is told: the app holds the limits.
   * maxRevisionsPerTurn (1..20): plan versions the model may commit for one GM message before the app stops between
   * steps and asks whether to go on (ChatEvent turn_finished stopReason "revision_limit").
   * view3d: the model may look at the build in 3D while revising (when it takes images).
   * maxPicturesPerTurn (0..12): 3D pictures the model may take for one GM message.
   */
  agent?: { maxRevisionsPerTurn: number; view3d: boolean; maxPicturesPerTurn: number };
}
