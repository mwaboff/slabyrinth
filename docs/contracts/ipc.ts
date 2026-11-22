/**
 * Slabyrinth — IPC contract between Electron main and the sandboxed renderer.
 * NORMATIVE CONTRACT. Copy verbatim into apps/desktop/src/shared/ipc.ts.
 *
 * - Requests: renderer → main via ipcRenderer.invoke(channel, payload) / ipcMain.handle.
 *   Every handler validates its payload with Zod and checks event.senderFrame.url is the app origin.
 * - Events: main → renderer via webContents.send(channel, payload).
 * - The preload exposes ONLY `window.slabyrinth` (typed below) through contextBridge; no ipcRenderer leak.
 * - Nothing here is provider-specific: models are addressed by ModelSelection / ModelDescriptor.
 * - Secrets never cross IPC towards the renderer (apiKey.set is write-only).
 */
import type { MapPlan, LevelId, ThemeId } from "./plan";
import type { PlanOp, PlanVersion, ApplyResult } from "./ops";
import type { MapSelection } from "./resolved";
import type { ExportBundle, ChunkOptions, CompileEstimate, CatalogChangeReport, Palette } from "./compiler";
import type {
  ChatItem, EffortLevel, ModelDescriptor, ModelSelection, ProviderErrorInfo, ProviderId, StopReason,
  SwitchImpact, Usage, Cost,
} from "./provider";
import type { AppSettings, Phase, BuildRecord, ChatMessageMeta, ProjectFile } from "./project";
import type { DesignBrief, PlanIssue } from "./plan";
import type { PngExportOptions } from "./resolved";
import type { PlanDiff } from "./ops";
import type { ProviderInfo } from "./provider";

/**
 * What is still wrong with the plan after a turn that changed it (engine guard, decisions.md "Playability validation").
 * Same shape as core agent/checks OutstandingIssues. Error-level items first, then warnings; at most 20 items.
 */
export interface OutstandingIssues {
  version: number;
  errors: number;
  warnings: number;
  items: Array<Pick<PlanIssue, "severity" | "code" | "message" | "hint" | "elementId" | "levelId" | "cell">>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export interface AppError {
  code:
    | "validation" | "not_found" | "io" | "cancelled" | "busy" | "no_project" | "no_api_key"
    | "provider" | "unsupported" | "internal";
  message: string;
  provider?: ProviderErrorInfo;
}

/** Snapshot sent on open/new and after structural changes. */
export interface ProjectSnapshot {
  projectId: string;
  name: string;
  filePath: string | null;        // null = untitled (autosave only)
  dirty: boolean;
  plan: MapPlan | null;
  head: number;
  versions: Array<Omit<PlanVersion, "snapshot" | "cause"> & { causeType: PlanVersion["cause"]["type"] }>;
  undone: number[];
  approvedVersion: number | null;
  brief: DesignBrief;
  builds: BuildRecord[];
  conversation: {
    id: string;
    selection: ModelSelection;
    phase: Phase;
    items: ChatItem[];            // providerState stripped (renderer never needs raw provider payloads)
    meta: Record<string, ChatMessageMeta>;   // per assistant item id: model/effort/duration/cost/status/alternatives
    totals: { usage: Usage; cost: Cost | null; turns: number };
    toolMode: "native" | "json" | "none";
  };
  busy: { turnId: string } | null;
  /** Resume state (UX §8.9): view, composer draft, room-key scroll… (ProjectFile.ui). */
  ui: ProjectFile["ui"];
  /** Paste-guide position (ProjectFile.pasteGuide); null when no guide is open. */
  pasteGuide: NonNullable<ProjectFile["pasteGuide"]> | null;
  /** Last-used PNG export options (ProjectFile.pngExport); null = never exported. */
  pngExport: NonNullable<ProjectFile["pngExport"]> | null;
}

// ───────────────────────────── request channels ─────────────────────────────

export interface IpcRequests {
  "app:getInfo": { req: void; res: { version: string; platform: "win32" | "linux" | "darwin"; userDataPath: string } };

  "settings:get": { req: void; res: AppSettings };
  "settings:update": { req: Partial<AppSettings>; res: AppSettings };

  /** Write-only secret handling. */
  /**
   * storage: "auto" (default) keeps the key in memory only when the OS has no keyring (Linux basic_text); "allow_weak" = UX §8.3 "Store anyway"; "memory_only" = "Don't store — ask each session".
   * verify: main checks the key with the provider right after storing it (res.check); a key the provider rejects
   * as unauthorized (kind "auth") is removed again (memory and secret.bin), so res.stored is false and hasKey false.
   * weakAvailable: the key is kept in memory only, and "Store anyway" (secrets:storeWeak) is possible.
   */
  "secrets:setApiKey": { req: { providerId: ProviderId; apiKey: string; storage?: "auto" | "allow_weak" | "memory_only"; verify?: boolean }; res: { stored: boolean; backend: "os" | "basic_text" | "memory_only"; weakAvailable?: true; check?: { ok: true } | { ok: false; error: ProviderErrorInfo } } };
  /** "Store anyway (less secure)": writes the session-only key with weak protection; the renderer never re-sends it. */
  "secrets:storeWeak": { req: { providerId: ProviderId }; res: { stored: boolean; backend: "os" | "basic_text" | "memory_only" } };
  "secrets:clearApiKey": { req: { providerId: ProviderId }; res: void };
  /**
   * hint: masked key for display ("sk-ant-…a1B2"); never the key itself.
   * unreadable: a key is saved but can't be decrypted (the system keyring changed); hasKey is then false.
   * weakAvailable: the key is kept in memory only and could be stored with weak protection (secrets:storeWeak).
   */
  "secrets:status": { req: void; res: Record<ProviderId, { hasKey: boolean; backend: "os" | "basic_text" | "memory_only" | null; hint: string | null; unreadable?: true; weakAvailable?: true }> };

  "providers:list": { req: void; res: Array<ProviderInfo & { enabled: boolean }> };
  "providers:check": { req: { providerId: ProviderId }; res: { ok: true } | { ok: false; error: ProviderErrorInfo } };
  /** Cached ≤ 24 h unless refresh. Includes static fallbacks when offline. */
  "models:list": { req: { providerId: ProviderId; refresh?: boolean }; res: ModelDescriptor[] };

  "project:new": { req: { name?: string; selection?: ModelSelection }; res: ProjectSnapshot };
  /**
   * Paths from the renderer (open, duplicate, trash, revealInFolder) are accepted only when main handed them out
   * (project:list, recents, a native dialog pick): absolute, local (no UNC), ".slabyrinth". Anything else → "validation".
   */
  "project:open": { req: { path?: string }; res: ProjectSnapshot | null };        // no path → native dialog
  /** Projects are files in the projects folder and autosave on every change; there is no Save command. */
  "project:saveCopyAs": { req: void; res: { path: string } | null };
  "project:rename": { req: { name: string }; res: void };
  "project:duplicate": { req: { path: string }; res: { path: string } };
  /** Moves the file to the OS trash (shell.trashItem). */
  "project:trash": { req: { path: string }; res: void };
  "project:revealInFolder": { req: { path: string }; res: void };
  "project:close": { req: { discardUnsaved?: boolean }; res: { closed: boolean } };
  "project:snapshot": { req: void; res: ProjectSnapshot };
  /** Resume state (UX §8.9): view, composer draft, paste-guide step. Shallow-merged into ProjectFile.ui; pasteGuide null clears it. Autosaved. */
  /** pngExport: the last-used PNG export options, replaced whole (also recorded by export:savePng). */
  "project:setUiState": { req: { ui?: Partial<Omit<ProjectFile["ui"], "lastActivityAt">>; pasteGuide?: ProjectFile["pasteGuide"] | null; pngExport?: NonNullable<ProjectFile["pngExport"]> }; res: void };
  /** Projects dialog: recent index + scan of the projects folder (thumbnail = small PNG of L1, cached). */
  "project:list": { req: void; res: Array<{ path: string; name: string; updatedAt: string; exists: boolean; levels: number; rooms: number; phase: "brief" | "plan" | "build"; thumbnailPng?: string }> };
  /** Plan JSON import/export always go through the native dialog; the renderer never names the file (architecture §6.5). */
  "project:importPlan": { req: void; res: ProjectSnapshot | null };
  "project:exportPlan": { req: void; res: { path: string } | null };

  /** UI edits use the SAME op language as the model. Rejected while a turn is running (code "busy"). */
  "plan:applyOps": { req: { baseVersion: number; label: string; ops: PlanOp[] }; res: ApplyResult & { version?: number } };
  "plan:undo": { req: void; res: { head: number } };
  "plan:redo": { req: void; res: { head: number } };
  /** Restore = new version copying vN (UX §7.1). */
  "plan:restore": { req: { version: number }; res: { head: number } };
  "plan:getVersion": { req: { version: number }; res: MapPlan };
  "plan:diff": { req: { from: number; to: number }; res: PlanDiff };
  /** Local, instant pre-approval checks (UX §7.5): blocking issues prevent approval. */
  "plan:approve": { req: { version: number }; res: { approved: boolean; blocking: string[]; warnings: string[] } };
  /** Direct text edits (names, notes, readAloud, encounter) — merged into one version per element within 2 min. */
  "plan:editText": { req: { id: string; set: Record<string, string | null> }; res: { head: number } };

  "brief:update": { req: { set: Partial<Record<keyof DesignBrief, unknown>> }; res: DesignBrief };

  /** Starts a turn; streaming arrives as "chat:event". Fails "busy" if a turn is running. */
  /** answers: replies to a pending ask_questions card (becomes that call's tool_result). intent drives Smart effort. */
  "chat:send": { req: { text: string; selection?: MapSelection; imageBlobs?: string[]; answers?: { callId: string; answers: Array<{ id: string; answer: string | null }> }; intent?: "chat" | "plan" | "auto" }; res: { turnId: string } };
  /** Pre-send estimate for the composer hint (UX §5.8): rounded cost and time. */
  "chat:estimate": { req: { text: string; selection?: ModelSelection; intent?: "chat" | "plan" | "auto" }; res: { costUsd: number | null; seconds: number | null; basis: "history" | "table" } };
  "chat:cancel": { req: { turnId: string }; res: void };
  /** Re-run the last failed/cancelled/refused turn (same user message). */
  "chat:retry": { req: { selection?: ModelSelection }; res: { turnId: string } };
  /** Show another alternative of a retried turn (display only). */
  "chat:selectAlternative": { req: { messageId: string; index: number }; res: void };
  /** Continue after stopReason max_tokens on a text answer. */
  "chat:continue": { req: void; res: { turnId: string } };
  /** Advisory impact of switching; UI confirms, then calls chat:setSelection. */
  "chat:previewSwitch": { req: { selection: ModelSelection }; res: SwitchImpact };
  "chat:setSelection": { req: { selection: ModelSelection }; res: { selection: ModelSelection } };
  "chat:setEffort": { req: { effort: EffortLevel | null }; res: { selection: ModelSelection } };
  /** Start a fresh conversation on the same map (old one kept read-only). */
  "chat:newConversation": { req: { selection?: ModelSelection }; res: ProjectSnapshot };

  "compile:estimate": { req: { levels?: LevelId[] }; res: CompileEstimate };
  /** Long-running: progress via "compile:progress". */
  "compile:run": { req: { version?: number; options?: ChunkOptions }; res: ExportBundle & { buildId: string } };
  "compile:cancel": { req: void; res: void };
  "build:setPasted": { req: { buildId: string; chunkId: string; pasted: boolean }; res: void };
  "build:saveChunk": { req: { buildId: string; chunkId: string }; res: { path: string } | null };

  /** Renderer rasterizes (OffscreenCanvas) and hands PNG bytes to main, which shows the native save dialog. */
  "export:savePng": { req: { suggestedName: string; files: Array<{ levelId: LevelId; pngBase64: string }>; options: PngExportOptions }; res: { paths: string[] } | null };
  "export:roomKeyMarkdown": { req: { copyToClipboard: boolean }; res: { markdown: string; path?: string } };

  /** chunk: when the text is a build chunk, main records BuildRecord chunk `copiedAt`. */
  "clipboard:writeText": { req: { text: string; chunk?: { buildId: string; chunkId: string } }; res: void };

  /**
   * Native folder picker for two purposes only (the renderer gets no general file-system picker). null = cancelled.
   * Nothing is saved: the renderer then calls talespire:setPath / settings:update { projects: { folder } }.
   * "talespire": the folder is checked with core's install rule; `path` is the normalised install folder when valid.
   */
  "dialog:pickFolder": { req: { purpose: "talespire" | "projects" }; res: { path: string; valid: true } | { path: string; valid: false; reason: "not_found" | "not_talespire"; message: string } | null };
  "talespire:locate": { req: void; res: { found: Array<{ path: string; source: "steam" | "manual" | "settings" }> } };
  "talespire:setPath": { req: { path: string | null }; res: { valid: boolean; reason?: string } };
  /** Asset library status (startup check runs automatically; fingerprint compare is cheap). */
  "catalog:status": { req: void; res: { state: "no_install" | "fresh" | "stale" | "rebuilding" | "error"; usingBuiltInOnly: boolean; generatedAt: string | null; assets: number; lastReport: CatalogChangeReport | null } };
  /** "Refresh asset library": re-fingerprint, rebuild if changed (or force), report what changed. Read-only on the install. */
  "catalog:refresh": { req: { force?: boolean }; res: CatalogChangeReport };
  /**
   * "Copy & open TaleSpire" (MVP replacement for impossible board import): main writes the slab to the clipboard,
   * then detects whether TaleSpire is running; if running → tries to bring it to front, else launches it via
   * steam://rungameid/720620 (allowlisted). The renderer shows the paste guide either way.
   */
  "talespire:copyAndOpen": { req: { text: string; chunk?: { buildId: string; chunkId: string } }; res: { copied: boolean; running: boolean; action: "focused" | "launched" | "focus_unavailable" | "not_installed" | "failed"; message?: string } };
  "talespire:isRunning": { req: void; res: { running: boolean } };
  /** Only "talespire://asset/<uuid>" and "steam://rungameid/720620" are accepted. */
  "talespire:openUrl": { req: { url: string }; res: { opened: boolean } };

  "palettes:list": { req: void; res: Array<{ id: string; name: string; source: "bundled" | "user"; extends?: string; issues: number }> };
  "palettes:reload": { req: void; res: void };
  "palettes:openFolder": { req: void; res: void };
  /**
   * The palettes builds compile with (bundled + user files + the scanned game assets), as the plain data the renderer
   * resolves plans against, so the 2D preview shows the map the build produces (core palette/transfer.ts). Fetched at
   * start and again after "palettes:changed".
   */
  "palettes:resolveData": { req: void; res: ResolvePalettesData };

  /** Opens https URLs from an allowlist (docs, GitHub releases, console.anthropic.com) in the system browser. */
  "shell:openExternal": { req: { url: string }; res: { opened: boolean } };

  /** Update notice: main asks GitHub's latest-release API; the renderer never fetches. */
  "updates:status": { req: void; res: UpdateStatus };
  /** manual: the "Check for updates" button (ignores the daily throttle and the autoCheck setting; allowed in dev). */
  "updates:check": { req: { manual: boolean }; res: UpdateStatus };
  /** "Skip this version": no chip for this version; a newer one shows again. */
  "updates:skip": { req: { version: string }; res: UpdateStatus };

  /** Slabyrinth Helper, the TaleSpire add-on (a symbiote): looks again for the Symbiotes folder and the installed copy. */
  "addon:status": { req: void; res: AddonStatus };
  /**
   * Install, update now or reinstall: copies the bundled add-on into the Symbiotes folder and writes its pairing file.
   * Fails "not_found" with no folder and "validation" over a folder of another add-on ("foreign"). Deletes nothing.
   * (An installed, older add-on is also updated by itself when the app starts; a missing one is never installed by itself.)
   */
  "addon:install": { req: void; res: AddonStatus };
  /**
   * Native folder picker for the Symbiotes folder, saved as talespire.symbiotesFolder; reset: back to finding it
   * automatically. null = cancelled. Fails "validation" for a folder the app cannot write in; one that does not look like
   * TaleSpire's is kept with AddonStatus.folderWarning.
   */
  "addon:chooseFolder": { req: { reset?: boolean }; res: AddonStatus | null };
  /**
   * Removes the add-on's own folder (only one recognisably ours, a real folder directly inside the Symbiotes folder;
   * never the Symbiotes folder or anything beside it). elsewhere: the copy at AddonStatus.elsewhere instead ("move it":
   * addon:install, then this). Fails "validation" for a folder that is not ours, "io" with a plain reason otherwise.
   */
  "addon:uninstall": { req: { elsewhere?: boolean }; res: AddonStatus };
  /** Opens a folder in the file manager: "installed" = the add-on in the Symbiotes folder (or the Symbiotes folder); "package" = a paired copy to install by hand. */
  "addon:openFolder": { req: { which: "installed" | "package" }; res: { opened: boolean; path: string | null } };
  /** "Don't ask again" on the update dialog, for this bundled version (saved as talespire.addonPromptDismissed). */
  "addon:dismissPrompt": { req: { version: string }; res: AddonStatus };
  "link:status": { req: void; res: LinkStatus };
  /** Sends a build's chunks to the connected add-on (fails "validation" when none is connected, or a chunk has no assets). */
  "link:send": { req: { buildId: string }; res: { chunks: number } };
  /** Empties the add-on (it drops the set) and releases the hotkeys. */
  "link:stop": { req: void; res: void };
}

/** Slabyrinth Helper in TaleSpire's Symbiotes folder (main looks again on window focus and every few seconds). */
export interface AddonStatus {
  /**
   * not_found: no Symbiotes folder (TaleSpire not found here; choose it by hand) · missing: the folder is there, the
   * add-on is not · installed: the bundled version, paired with this app · outdated: older than the bundled one ·
   * mismatch: paired with another port or token (another copy of the app wrote it): install again ·
   * foreign: a folder of the same name holds something else; the app never writes into it.
   */
  state: "not_found" | "missing" | "installed" | "outdated" | "mismatch" | "foreign";
  /** The Symbiotes folder in use, or null. */
  folder: string | null;
  /** manual: chosen by hand · default: the Windows folder · proton: inside Steam's Proton prefix (Linux). */
  folderSource: "manual" | "default" | "proton" | null;
  /** Every Symbiotes folder looked for, for the "not found" help. */
  tried: string[];
  /** A folder chosen by hand that does not look like TaleSpire's Symbiotes folder (kept; the UI warns). */
  folderWarning: string | null;
  /** Our add-on also installed in another Symbiotes folder (the detected one, or the one used before a change). */
  elsewhere: { folder: string; version: string } | null;
  /** The add-on's own folder (<folder>/slabyrinth-helper) when installed. */
  addonPath: string | null;
  bundledVersion: string;
  installedVersion: string | null;
  /** What differs when state is "mismatch". */
  mismatch: Array<"token" | "port">;
  /**
   * The last install or update this run: automatic (at start, an installed older copy) or by the user. failed keeps
   * the plain reason (a locked file, no permission); the add-on then stays as it was and installing by hand still works.
   */
  update: { state: "none" | "updated" | "failed"; automatic: boolean; from: string | null; to: string | null; at: string | null; error: string | null };
  /**
   * The "update the add-on for you?" dialog: show while the installed copy is older than the bundled one, the automatic
   * update did not do it, and the user has not said "don't ask again" for this bundled version (addon:dismissPrompt).
   * reason: why the automatic update did not happen, in plain words.
   */
  prompt: { show: boolean; reason: string | null };
  checkedAt: string;
}

/** One global hotkey of the add-on link (registered by the app only while a map is being placed). */
export interface LinkHotkey {
  /** active: registered · standby: chosen, registered once a map is loaded · refused: see reason (combo = the one kept) · none. */
  status: "active" | "standby" | "refused" | "none";
  combo: string | null;
  wanted?: string;
  reason?: string;
}

/** The local link between the app and the add-on (127.0.0.1 only). */
export interface LinkStatus {
  /** port_in_use: another program holds the port (for example the old development bridge). */
  server: { state: "starting" | "listening" | "port_in_use" | "failed"; port: number };
  /**
   * The add-on's connection. refused: it connected without this app's pairing (an old or hand-copied add-on, or
   * another app's): install it again. version: the add-on's own version as it said on connecting.
   */
  helper: { state: "none" | "connected" | "refused"; version: string | null; reason: "token" | "origin" | "protocol" | null };
  /** The map loaded in the add-on, as it last reported; null when none. chunk is 1-based; finished after the last chunk. */
  set: { name: string; chunk: number; total: number; phase: "ready" | "sending" | "inHand" | "failed" | "done"; finished: boolean; status: string; cause: string | null } | null;
  /** The app's last send: sending until the add-on answers. */
  send: { state: "idle" | "sending" | "loaded" | "failed"; buildId: string | null; chunks: number; error: string | null };
  /**
   * off: no map being placed (nothing registered) · active / partial / failed: how many registered.
   * wayland: a Wayland session, where the desktop may refuse or ask first; the add-on's buttons always work.
   */
  hotkeys: { state: "off" | "active" | "partial" | "failed"; wayland: boolean; actions: Record<"next" | "back" | "again", LinkHotkey> };
}

/**
 * Palettes as plain data (same shape as core palette/transfer.ts ResolvePalettesData): the merged palettes and the
 * game status and name of every asset they name. `key` is a content hash: equal keys, equal palettes.
 */
export interface ResolvePalettesData {
  key: string;
  palettes: Record<ThemeId, Palette>;
  assets: Record<string, { status: "present" | "deprecated" | "missing" | null; name: string | null }>;
}

/** A newer release found by the update check. */
export interface UpdateInfo {
  /** Semver without the "v" ("0.2.0"). */
  version: string;
  /** The validated release tag ("v0.2.0"). */
  tag: string;
  publishedAt: string | null;
  /** Release notes: untrusted text, sanitized and capped in main. Shown only as an allow-listed Markdown subset of plain text (no HTML, no links, no images). */
  notes: string;
  /** https://github.com/mwaboff/slabyrinth/releases/tag/<tag>, built in main from the tag (never taken from the response). */
  url: string;
}

export interface UpdateStatus {
  state: "idle" | "checking" | "up_to_date" | "available" | "failed";
  currentVersion: string;
  /** ISO time of the last completed check, or null. */
  lastCheckedAt: string | null;
  /** Set when state is "available". */
  update: UpdateInfo | null;
  /** The available version is the one the user skipped (no chip; Settings still shows it). */
  skipped: boolean;
}

// ───────────────────────────── events (main → renderer) ─────────────────────────────

export type ChatEvent =
  | { type: "turn_started"; turnId: string; selection: ModelSelection }
  | { type: "item_appended"; turnId: string; item: ChatItem }               // user/context/tool_results/assistant (final) items
  | { type: "step_started"; turnId: string; step: number; servedBy: { providerId: ProviderId; modelId: string } }
  | { type: "text_delta"; turnId: string; step: number; text: string }
  | { type: "reasoning_delta"; turnId: string; step: number; text: string }
  | { type: "tool_call_started"; turnId: string; step: number; callId: string; name: string }
  | { type: "tool_call_progress"; turnId: string; callId: string; bytes: number }   // input bytes streamed so far (progress bar)
  /** Generation progress steps parsed from streamed create/edit input (UX §5.6). */
  | { type: "progress"; turnId: string; step: "reading_brief" | "laying_out_level" | "placing_openings" | "furnishing" | "writing_notes" | "checking"; label: string }
  | { type: "brief_updated"; turnId: string; brief: DesignBrief; skipped: string[] }
  | { type: "questions"; turnId: string; callId: string; questions: Array<{ id: string; text: string; default: string; options: string[] }> }
  | { type: "tool_call_finished"; turnId: string; callId: string; name: string; ok: boolean; summary: string; newVersion?: number }
  | { type: "notice"; turnId: string; kind: "fallback" | "compaction" | "truncated" | "refusal" | "retrying"; text: string }
  | { type: "usage"; turnId: string; usage: Usage; cost: Cost | null; totals: { usage: Usage; cost: Cost | null } }
  /** outstandingIssues: set when the turn changed the plan and error-level playability issues remain (whatever the model said); also on cancelled turns. */
  | { type: "turn_finished"; turnId: string; stopReason: StopReason; canContinue: boolean; canRetry: boolean; outstandingIssues?: OutstandingIssues }
  | { type: "turn_failed"; turnId: string; error: AppError; canRetry: boolean; outstandingIssues?: OutstandingIssues };

export interface IpcEvents {
  "chat:event": ChatEvent;
  /** New head (any author). Renderer re-resolves locally. */
  "plan:changed": { head: number; plan: MapPlan | null; version: Omit<PlanVersion, "snapshot" | "cause"> & { causeType: PlanVersion["cause"]["type"] } };
  "project:changed": { dirty: boolean; filePath: string | null; name: string };
  "catalog:changed": CatalogChangeReport;
  /** Non-blocking startup warning when no install / unparseable index: app runs on bundled palettes only. */
  "catalog:warning": { kind: "no_install" | "parse_failed"; message: string };
  /** The build's palettes changed (palette files reloaded, asset library rescanned): fetch palettes:resolveData. */
  "palettes:changed": { key: string };
  "compile:progress": { stage: "resolve" | "realize" | "chunk" | "encode"; done: number; total: number };
  "settings:changed": AppSettings;
  /** Main asks renderer to rasterize a level for view_map_image (renderer replies via "render:imageResult"). */
  "render:requestImage": { requestId: string; level: LevelId; region?: { x: number; y: number; w: number; h: number }; showIds: boolean; planVersion: number; maxPx: number };
  "menu:command": { command: "new" | "open" | "save" | "saveAs" | "undo" | "redo" | "export" | "settings" };
  /** An update check (startup or manual) found a newer version that isn't skipped. Never opens anything by itself. */
  "updates:available": UpdateStatus;
  /** The add-on's install status changed (found, installed by hand, updated, removed). */
  "addon:changed": AddonStatus;
  /** The link changed: the add-on connected or left, progress, hotkeys. */
  "link:changed": LinkStatus;
}

/** Renderer → main one-way messages (ipcRenderer.send). */
export interface IpcSends {
  "render:imageResult": { requestId: string; ok: true; pngBase64: string } | { requestId: string; ok: false; error: string };
}

// ───────────────────────────── preload surface ─────────────────────────────

export interface SlabyrinthApi {
  invoke<C extends keyof IpcRequests>(channel: C, req: IpcRequests[C]["req"]): Promise<Result<IpcRequests[C]["res"]>>;
  on<C extends keyof IpcEvents>(channel: C, listener: (payload: IpcEvents[C]) => void): () => void;
  send<C extends keyof IpcSends>(channel: C, payload: IpcSends[C]): void;
}

declare global {
  interface Window { slabyrinth: SlabyrinthApi }
}
