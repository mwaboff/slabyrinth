import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { approve as approveHistory, planGate } from "@slabyrinth/core";
import type { DesignBrief, LevelId, MapPlan, PlanDiff, PlanOp, ApplyResult } from "@slabyrinth/core";
import type { ChatItem, Cost, ModelSelection, Usage } from "../agent/provider/types";
import type { IpcRequests, ProjectSnapshot } from "../../shared/ipc";
import type { BuildRecord, ChatMessageMeta, Conversation, ProjectFile } from "../../shared/project";
import type { Logger } from "../logger";
import type { PlanCorePort } from "../ports/core";
import type { CommitVersionInput } from "../ports/engine";
import { writeFileAtomic } from "../util/atomicWrite";
import { checkLocalPath, pathKey } from "../util/safePath";
import { AppFailure, isNodeError } from "../util/errors";
import { PROJECT_FILTER, type Dialogs } from "./dialogs";
import type { EmitEvent } from "./events";
import * as history from "./history";
import {
  activeConversation,
  buildSnapshot,
  countRooms,
  derivePhase,
  newConversation,
  newProjectFile,
  parseProject,
  readProjectBytes,
  serializeProject,
  UNKNOWN_CONVERSATION_DEFAULTS,
  versionSummary,
  type ConversationDefaults,
} from "./projectFile";
import { ProjectLock, defaultLockEnv, type LockEnv } from "./projectLock";
import type { SettingsStore } from "./settingsStore";

/**
 * ProjectService (architecture §6.1, §6.4): owns the authoritative state of the ONE open project.
 * The engine (through EngineHost) and the UI (through IPC) mutate it only through this class.
 *  - autosave: every mutation schedules a write (debounced 1 s); `flush()` writes now;
 *  - crash-safe writes (temp + fsync + rename, `.bak` of the previous good copy), serialized;
 *  - single-writer lock (`<file>.lock`), migration hook (core migrateProject), recent index.
 */
export const PROJECT_EXT = ".slabyrinth";
/** Largest plan JSON file accepted by Import plan. */
const PLAN_FILE_MAX_BYTES = 16 * 1024 * 1024;
const TEXT_FIELDS = new Set(["name", "notes", "readAloud", "encounter", "label", "text", "description"]);
const TEXT_MERGE_WINDOW_MS = 2 * 60 * 1000;

export interface ProjectServiceDeps {
  settings: SettingsStore;
  core: PlanCorePort;
  dialogs: Dialogs;
  emit: EmitEvent;
  logger: Logger;
  appVersion: string;
  trashItem: (file: string) => Promise<void>;
  showItemInFolder: (file: string) => void;
  lockEnv?: LockEnv;
  autosaveDelayMs?: number;
  /** Injected for crash tests; default writeFileAtomic with `.bak` rotation. */
  writeFile?: (file: string, data: string) => Promise<void>;
  now?: () => Date;
}

interface OpenState {
  project: ProjectFile;
  filePath: string;
  lock: ProjectLock | null;
  revision: number;
  savedRevision: number;
  busy: { turnId: string } | null;
  planCache: Map<number, MapPlan>;
  lastDirtyEmitted: boolean;
}

export interface ProjectListEntry {
  path: string;
  name: string;
  updatedAt: string;
  exists: boolean;
  levels: number;
  rooms: number;
  phase: "brief" | "plan" | "build";
  thumbnailPng?: string;
}

export interface EngineHooks {
  onClosing(): Promise<void>;
  onOpened(): void;
  conversationDefaults(selection: ModelSelection): ConversationDefaults;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function sanitizeFileName(name: string): string {
  let s = name
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (s.length === 0) s = "Untitled map";
  if (s.length > 80) s = s.slice(0, 80).trim();
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  return s;
}

export class ProjectService {
  private state: OpenState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private hooks: EngineHooks | null = null;
  private readonly listCache = new Map<string, { mtimeMs: number; size: number; entry: ProjectListEntry }>();
  /** Project paths main has handed to the renderer (list, recents, dialogs, create/duplicate results). */
  private readonly knownPaths = new Set<string>();
  /** open/new/close/duplicate/trash/import run one at a time, so a lock is never replaced without release(). */
  private lifecycleChain: Promise<unknown> = Promise.resolve();

  private lifecycle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycleChain.catch(() => undefined).then(fn);
    this.lifecycleChain = run;
    return run;
  }

  private remember(p: string): string {
    this.knownPaths.add(pathKey(p));
    return p;
  }

  /**
   * A project path from the renderer: local, absolute, normalised `.slabyrinth` (checkLocalPath) AND
   * one main handed out (project:list, recents, a native dialog pick, a create/duplicate/copy result).
   */
  acceptProjectPath(raw: string): string {
    const p = checkLocalPath(raw, { ext: PROJECT_EXT });
    const key = pathKey(p);
    const known =
      this.knownPaths.has(key) ||
      this.deps.settings.get().projects.recent.some((r) => pathKey(r) === key) ||
      (this.state !== null && pathKey(this.state.filePath) === key);
    if (!known) throw new AppFailure("validation", "That map isn't one Slabyrinth listed.");
    return p;
  }

  constructor(private readonly deps: ProjectServiceDeps) {}

  setEngineHooks(hooks: EngineHooks | null): void {
    this.hooks = hooks;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  get isOpen(): boolean {
    return this.state !== null;
  }

  get filePath(): string | null {
    return this.state?.filePath ?? null;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private projectsFolder(): string {
    return this.deps.settings.get().projects.folder;
  }

  private convDefaults(selection: ModelSelection): ConversationDefaults {
    return this.hooks?.conversationDefaults(selection) ?? UNKNOWN_CONVERSATION_DEFAULTS;
  }

  create(req: IpcRequests["project:new"]["req"]): Promise<ProjectSnapshot> {
    return this.lifecycle(() => this.createInner(req));
  }

  private async createInner(req: IpcRequests["project:new"]["req"]): Promise<ProjectSnapshot> {
    await this.closeInner({});
    const settings = this.deps.settings.get();
    const name = (req.name ?? "").trim() || "Untitled map";
    const selection = req.selection ?? settings.defaultSelection;
    const project = newProjectFile({
      name,
      selection,
      appVersion: this.deps.appVersion,
      conversation: this.convDefaults(selection),
    });
    // The default game system from settings (UX setup step 3) starts the brief as the GM's own value.
    if (settings.defaultSystem !== null)
      project.brief.system = { value: settings.defaultSystem.system, source: "user" };
    const folder = this.projectsFolder();
    await fsp.mkdir(folder, { recursive: true });
    const file = await this.uniquePath(folder, sanitizeFileName(name));
    const lock = await ProjectLock.acquire(file, this.deps.lockEnv ?? defaultLockEnv());
    if (!lock.ok) throw new AppFailure("busy", "That project file is in use by another Slabyrinth window.");
    this.state = this.openState(project, file, lock.lock);
    this.state.revision = 1;
    this.remember(file);
    await this.flush();
    await this.deps.settings.touchRecent(file);
    this.deps.logger.info("project created", { file, projectId: project.id });
    this.hooks?.onOpened();
    this.emitChanged(true);
    return this.snapshot();
  }

  /**
   * Opens a project; no path → native open dialog. Returns null when the user cancels. A given path
   * must pass acceptProjectPath (renderer-supplied); `trusted` is for paths main itself found
   * (file association, last project on launch).
   */
  open(req: { path?: string | undefined }, trusted = false): Promise<ProjectSnapshot | null> {
    return this.lifecycle(() => this.openInner(req, trusted));
  }

  private async openInner(
    req: { path?: string | undefined },
    trusted: boolean,
  ): Promise<ProjectSnapshot | null> {
    let file = req.path === undefined || trusted ? req.path : this.acceptProjectPath(req.path);
    if (file === undefined) {
      const picked = await this.deps.dialogs.openFile({
        title: "Open map",
        filters: [PROJECT_FILTER],
        defaultPath: this.projectsFolder(),
      });
      if (picked === null) return null;
      file = picked;
    }
    file = path.resolve(file);
    if (this.state && samePath(this.state.filePath, file)) return this.snapshot();

    const loaded = await this.readForOpen(file);
    if (loaded === null) return null;

    await this.closeInner({});
    const env = this.deps.lockEnv ?? defaultLockEnv();
    let lock = await ProjectLock.acquire(file, env);
    if (!lock.ok) {
      const other = lock.holder.host !== env.host;
      const go = await this.deps.dialogs.confirm({
        title: "Project in use",
        message: other
          ? `This map seems to be open on another computer (${lock.holder.host}).`
          : "This map is open in another Slabyrinth window.",
        detail: "Opening it here as well can lose changes made in the other window. Open it anyway?",
        okLabel: "Open anyway",
        cancelLabel: "Cancel",
      });
      if (!go) throw new AppFailure("busy", "That map is open somewhere else.");
      lock = await ProjectLock.acquire(file, env, { force: true });
      if (!lock.ok) throw new AppFailure("busy", "That map is open somewhere else.");
    }
    this.state = this.openState(loaded.project, file, lock.lock);
    this.remember(file);
    if (loaded.migratedFrom !== null || loaded.dirty) {
      this.state.revision = 1; // write the upgraded/recovered file back
      if (loaded.migratedFrom !== null) {
        await fsp.copyFile(file, `${file}.v${String(loaded.migratedFrom)}.bak`).catch(() => undefined);
      }
      this.scheduleSave();
    }
    this.verifyHead();
    await this.deps.settings.touchRecent(file);
    this.deps.logger.info("project opened", {
      file,
      projectId: loaded.project.id,
      migratedFrom: loaded.migratedFrom,
    });
    this.hooks?.onOpened();
    this.emitChanged(true);
    return this.snapshot();
  }

  private async readForOpen(
    file: string,
  ): Promise<{ project: ProjectFile; migratedFrom: number | null; dirty: boolean } | null> {
    let bytes: Buffer;
    try {
      bytes = await readProjectBytes(file);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        await this.deps.settings.removeRecent(file);
        throw new AppFailure("not_found", "That map file no longer exists.");
      }
      throw err;
    }
    const migrate = (json: unknown): unknown => this.deps.core.migrateProject(json);
    const outcome = parseProject(bytes, migrate);
    if (outcome.ok) return { project: outcome.project, migratedFrom: outcome.migratedFrom, dirty: false };
    if (outcome.reason !== "corrupt") throw new AppFailure("validation", outcome.message);

    // Damaged file: offer the previous good copy (architecture §6.4).
    const bak = `${file}.bak`;
    let bakBytes: Buffer | null;
    try {
      bakBytes = await readProjectBytes(bak);
    } catch {
      bakBytes = null;
    }
    const bakOutcome = bakBytes ? parseProject(bakBytes, migrate) : null;
    if (!bakOutcome?.ok) throw new AppFailure("validation", outcome.message);
    const useBak = await this.deps.dialogs.confirm({
      title: "Damaged map file",
      message: "This map file is damaged. Open the last good copy instead?",
      detail: `The backup was saved ${bakOutcome.project.updatedAt}. The damaged file is kept next to it as .damaged.`,
      okLabel: "Open backup",
      cancelLabel: "Cancel",
    });
    if (!useBak) return null;
    await fsp.copyFile(file, `${file}.damaged`).catch(() => undefined);
    this.deps.logger.warn("project recovered from .bak", { file });
    return { project: bakOutcome.project, migratedFrom: bakOutcome.migratedFrom, dirty: true };
  }

  private openState(project: ProjectFile, filePath: string, lock: ProjectLock | null): OpenState {
    return {
      project,
      filePath,
      lock,
      revision: 0,
      savedRevision: 0,
      busy: null,
      planCache: new Map(),
      lastDirtyEmitted: false,
    };
  }

  /** Head plan must equal reconstruct(history, head); the denormalized copy wins if replay is impossible. */
  private verifyHead(): void {
    const s = this.state;
    if (!s || s.project.history.head === 0) return;
    try {
      const rebuilt = history.reconstruct(
        s.project.history,
        s.project.history.head,
        this.deps.core.rules(),
        s.planCache,
      );
      if (JSON.stringify(rebuilt) !== JSON.stringify(s.project.plan)) {
        this.deps.logger.warn("head plan differs from history replay; keeping the stored plan", {
          head: s.project.history.head,
        });
      }
    } catch (err) {
      this.deps.logger.warn("history replay unavailable on open", { error: err });
    }
    if (s.project.plan) s.planCache.set(s.project.history.head, s.project.plan);
  }

  close(req: { discardUnsaved?: boolean | undefined }): Promise<{ closed: boolean }> {
    return this.lifecycle(() => this.closeInner(req));
  }

  private async closeInner(req: { discardUnsaved?: boolean | undefined }): Promise<{ closed: boolean }> {
    const s = this.state;
    if (!s) return { closed: true };
    await this.hooks?.onClosing().catch((err: unknown) => {
      this.deps.logger.warn("engine onClosing failed", { error: err });
    });
    if (req.discardUnsaved === true) {
      this.clearTimer();
    } else {
      await this.flush();
    }
    await this.writeChain.catch(() => undefined);
    await s.lock?.release();
    this.state = null;
    this.deps.logger.info("project closed", { file: s.filePath });
    return { closed: true };
  }

  /** Releases the lock synchronously (process exit after a failed flush). */
  releaseLockSync(unlinkSync: (p: string) => void): void {
    this.state?.lock?.releaseSync(unlinkSync);
  }

  snapshot(): ProjectSnapshot {
    const s = this.require();
    return buildSnapshot(s.project, s.filePath, s.revision !== s.savedRevision, s.busy);
  }

  getProject(): Readonly<ProjectFile> | null {
    return this.state?.project ?? null;
  }

  // ───────────────────────────── persistence ─────────────────────────────

  private require(): OpenState {
    if (!this.state) throw new AppFailure("no_project", "No map is open.");
    return this.state;
  }

  /** Applies a mutation to the open project and schedules an autosave. */
  mutate<T>(fn: (p: ProjectFile) => T): T {
    const s = this.require();
    const result = fn(s.project);
    s.project.updatedAt = this.now().toISOString();
    s.revision += 1;
    this.scheduleSave();
    this.emitChanged(false);
    return result;
  }

  private scheduleSave(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch((err: unknown) => {
        this.deps.logger.error("autosave failed", { error: err });
      });
    }, this.deps.autosaveDelayMs ?? 1000);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Writes the open project now if it changed. Writes are serialized; the latest state wins. */
  flush(): Promise<void> {
    this.clearTimer();
    const s = this.state;
    if (!s) return this.writeChain;
    const run = async (): Promise<void> => {
      if (this.state !== s || s.revision === s.savedRevision) return;
      const revision = s.revision;
      s.project.appVersion = this.deps.appVersion;
      const data = serializeProject(s.project);
      const write =
        this.deps.writeFile ?? ((f: string, d: string) => writeFileAtomic(f, d, { backup: true }));
      await write(s.filePath, data);
      s.savedRevision = Math.max(s.savedRevision, revision);
      this.emitChanged(false);
    };
    this.writeChain = this.writeChain.catch(() => undefined).then(run);
    return this.writeChain;
  }

  private emitChanged(force: boolean): void {
    const s = this.state;
    if (!s) return;
    const dirty = s.revision !== s.savedRevision;
    if (!force && dirty === s.lastDirtyEmitted) return;
    s.lastDirtyEmitted = dirty;
    this.deps.emit("project:changed", { dirty, filePath: s.filePath, name: s.project.name });
  }

  private async uniquePath(folder: string, base: string, ignore?: string): Promise<string> {
    for (let i = 1; i < 1000; i++) {
      const candidate = path.join(folder, `${i === 1 ? base : `${base} ${String(i)}`}${PROJECT_EXT}`);
      if (ignore !== undefined && samePath(candidate, ignore)) return candidate;
      try {
        await fsp.access(candidate);
      } catch {
        return candidate;
      }
    }
    return path.join(folder, `${base} ${randomUUID().slice(0, 8)}${PROJECT_EXT}`);
  }

  // ───────────────────────────── file commands ─────────────────────────────

  async saveCopyAs(): Promise<{ path: string } | null> {
    const s = this.require();
    const target = await this.deps.dialogs.saveFile({
      title: "Save a copy as",
      defaultPath: path.join(
        path.dirname(s.filePath),
        `${sanitizeFileName(`${s.project.name} copy`)}${PROJECT_EXT}`,
      ),
      filters: [PROJECT_FILTER],
    });
    if (target === null) return null;
    if (samePath(target, s.filePath))
      throw new AppFailure("validation", "Choose a different file for the copy.");
    await writeFileAtomic(target, serializeProject(s.project));
    return { path: this.remember(target) };
  }

  async rename(name: string): Promise<void> {
    this.ensureNotBusy();
    const s = this.require();
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new AppFailure("validation", "A map needs a name.");
    this.mutate((p) => {
      p.name = trimmed;
    });
    // Keep the file name in step when the project lives in the projects folder.
    if (samePath(path.dirname(s.filePath), this.projectsFolder())) {
      const target = await this.uniquePath(path.dirname(s.filePath), sanitizeFileName(trimmed), s.filePath);
      if (!samePath(target, s.filePath)) {
        await this.flush();
        // Inside the write chain: no autosave can run between the move and repointing filePath,
        // and every later write targets the new path (never resurrects the old file).
        const old = s.filePath;
        const move = this.writeChain
          .catch(() => undefined)
          .then(async () => {
            await fsp.rename(old, target);
            s.filePath = target;
            await fsp.rename(`${old}.bak`, `${target}.bak`).catch(() => undefined);
            await s.lock?.moveTo(target);
          });
        this.writeChain = move.catch(() => undefined);
        await move;
        this.remember(target);
        await this.deps.settings.removeRecent(old);
        await this.deps.settings.touchRecent(target);
      }
    }
    this.emitChanged(true);
  }

  async duplicate(file: string): Promise<{ path: string }> {
    const src = this.acceptProjectPath(file);
    return this.lifecycle(() => this.duplicateInner(src));
  }

  private async duplicateInner(src: string): Promise<{ path: string }> {
    let project: ProjectFile;
    if (this.state && samePath(this.state.filePath, src)) {
      await this.flush();
      project = structuredClone(this.state.project);
    } else {
      const outcome = parseProject(await readProjectBytes(src), (j) => this.deps.core.migrateProject(j));
      if (!outcome.ok) throw new AppFailure("validation", outcome.message);
      project = outcome.project;
    }
    project.id = randomUUID();
    project.name = `${project.name} (copy)`;
    const now = this.now().toISOString();
    project.createdAt = now;
    project.updatedAt = now;
    const target = await this.uniquePath(path.dirname(src), sanitizeFileName(project.name));
    await writeFileAtomic(target, serializeProject(project));
    return { path: this.remember(target) };
  }

  /** Moves an accepted project file to the OS trash; the only other file touched is its `.bak`. */
  async trash(file: string): Promise<void> {
    const target = this.acceptProjectPath(file);
    return this.lifecycle(async () => {
      if (this.state && samePath(this.state.filePath, target)) await this.closeInner({});
      await this.deps.trashItem(target);
      await fsp.unlink(`${target}.bak`).catch(() => undefined);
      await this.deps.settings.removeRecent(target);
      this.listCache.delete(target);
      this.knownPaths.delete(pathKey(target));
    });
  }

  revealInFolder(file: string): void {
    this.deps.showItemInFolder(this.acceptProjectPath(file));
  }

  /** Recent index + scan of the projects folder (Home / Projects dialog). */
  async list(): Promise<ProjectListEntry[]> {
    const settings = this.deps.settings.get();
    const seen = new Map<string, string>();
    const add = (p: string): void => {
      const key = process.platform === "win32" ? p.toLowerCase() : p;
      if (!seen.has(key)) seen.set(key, p);
    };
    for (const p of settings.projects.recent) add(path.resolve(p));
    try {
      for (const name of await fsp.readdir(settings.projects.folder)) {
        if (name.toLowerCase().endsWith(PROJECT_EXT)) add(path.join(settings.projects.folder, name));
      }
    } catch {
      // folder not created yet
    }
    if (this.state) await this.flush();
    const out: ProjectListEntry[] = [];
    for (const p of seen.values()) out.push(await this.describe(this.remember(p)));
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return out;
  }

  private async describe(file: string): Promise<ProjectListEntry> {
    const missing: ProjectListEntry = {
      path: file,
      name: path.basename(file, PROJECT_EXT),
      updatedAt: "",
      exists: false,
      levels: 0,
      rooms: 0,
      phase: "brief",
    };
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return missing;
    }
    const cached = this.listCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.entry;
    // Unreadable (too large, gzip bomb, damaged, not a project): listed by file name, never parsed again
    // until the file changes.
    const unreadable: ProjectListEntry = { ...missing, exists: true, updatedAt: st.mtime.toISOString() };
    let outcome: ReturnType<typeof parseProject>;
    try {
      outcome = parseProject(await readProjectBytes(file), (j) => this.deps.core.migrateProject(j));
    } catch (err) {
      this.deps.logger.warn("project unreadable in list", { file, error: err });
      this.listCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, entry: unreadable });
      return unreadable;
    }
    if (!outcome.ok) {
      this.listCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, entry: unreadable });
      return unreadable;
    }
    const p = outcome.project;
    const entry: ProjectListEntry = {
      path: file,
      name: p.name,
      updatedAt: p.updatedAt,
      exists: true,
      levels: p.plan?.levels.length ?? 0,
      rooms: countRooms(p),
      phase: derivePhase(p),
    };
    if (p.thumbnail) entry.thumbnailPng = p.thumbnail.pngBase64;
    this.listCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, entry });
    return entry;
  }

  /** Creates a project from a plan JSON file the user picks in the native dialog. */
  async importPlan(): Promise<ProjectSnapshot | null> {
    const src = await this.deps.dialogs.openFile({
      title: "Import map plan",
      filters: [{ name: "Map plan (JSON)", extensions: ["json"] }],
    });
    if (src === null) return null;
    let plan: MapPlan;
    try {
      const st = await fsp.stat(src);
      if (st.size > PLAN_FILE_MAX_BYTES) throw new Error("too large");
      plan = JSON.parse(await fsp.readFile(src, "utf8")) as MapPlan;
    } catch {
      throw new AppFailure("validation", "That file isn't a map plan (JSON).");
    }
    if (
      typeof plan !== "object" ||
      (plan as { schema?: unknown }).schema !== "slabyrinth/plan@1" ||
      !Array.isArray(plan.levels)
    ) {
      throw new AppFailure("validation", "That file isn't a Slabyrinth map plan (slabyrinth/plan@1).");
    }
    // an imported plan is a new version like the model's create_plan: the edit gate decides
    const errors = planGate(this.deps.core.validatePlan(plan), "edit").blocking;
    if (errors.length > 0) {
      throw new AppFailure(
        "validation",
        `The plan has ${String(errors.length)} error(s): ${errors[0]?.message ?? ""}`,
      );
    }
    return this.lifecycle(async () => {
      await this.createInner({
        name: typeof plan.title === "string" && plan.title ? plan.title : path.basename(src, ".json"),
      });
      this.commitVersion({ plan, author: "user", summary: "Imported plan", cause: { type: "create" } });
      await this.flush();
      return this.snapshot();
    });
  }

  /** Writes the head plan to a file the user picks in the native save dialog. */
  async exportPlan(): Promise<{ path: string } | null> {
    const s = this.require();
    if (!s.project.plan) throw new AppFailure("validation", "There's no plan to export yet.");
    const target = await this.deps.dialogs.saveFile({
      title: "Export map plan",
      defaultPath: `${sanitizeFileName(s.project.name)}.plan.json`,
      filters: [{ name: "Map plan (JSON)", extensions: ["json"] }],
    });
    if (target === null) return null;
    await writeFileAtomic(target, `${JSON.stringify(s.project.plan, null, 2)}\n`);
    return { path: target };
  }

  // ───────────────────────────── plan & history ─────────────────────────────

  setBusy(turn: { turnId: string } | null): void {
    const s = this.require();
    s.busy = turn;
  }

  private ensureNotBusy(): void {
    if (this.require().busy)
      throw new AppFailure("busy", "Slabyrinth is revising the map. Wait for it to finish or stop it.");
  }

  getPlan(version?: number): MapPlan | null {
    const s = this.require();
    const h = s.project.history;
    const n = version ?? h.head;
    if (n === 0) return null;
    if (n === h.head && s.project.plan) return s.project.plan;
    return history.reconstruct(h, n, this.deps.core.rules(), s.planCache);
  }

  commitVersion(input: CommitVersionInput): { version: number; plan: MapPlan } {
    const s = this.require();
    if (input.baseVersion !== undefined && input.baseVersion !== s.project.history.head) {
      throw new AppFailure("busy", `The plan moved to v${String(s.project.history.head)}.`);
    }
    const version = this.mutate((p) => {
      const nv: history.NewVersionInput = {
        plan: input.plan,
        author: input.author,
        summary: input.summary,
        cause: input.cause,
        createdAt: this.now().toISOString(),
      };
      if (input.changeSummary !== undefined) nv.changeSummary = input.changeSummary.slice(0, 6);
      if (input.messageId !== undefined) nv.messageId = input.messageId;
      if (input.cost !== undefined) nv.cost = input.cost;
      const v = history.commit(p.history, nv, this.deps.core.rules(), s.planCache);
      p.plan = structuredClone(input.plan);
      return v;
    });
    s.planCache.set(version.number, s.project.plan as MapPlan);
    this.emitPlanChanged();
    return { version: version.number, plan: s.project.plan as MapPlan };
  }

  /**
   * `from`: the head before a move. When the head moves back to 0 (no plan: Undo or Retry of the turn that
   * drew the first plan) the event still goes out, with `plan: null` and the version just left.
   */
  private emitPlanChanged(from?: number): void {
    const s = this.require();
    const h = s.project.history;
    const shown = h.head !== 0 ? h.head : from;
    if (shown === undefined || shown === 0) return;
    this.deps.emit("plan:changed", {
      head: h.head,
      plan: h.head === 0 ? null : s.project.plan,
      version: versionSummary(history.findVersion(h, shown)),
    });
  }

  applyOps(req: IpcRequests["plan:applyOps"]["req"]): ApplyResult & { version?: number } {
    this.ensureNotBusy();
    const s = this.require();
    if (req.baseVersion !== s.project.history.head) {
      throw new AppFailure(
        "validation",
        `The map changed (now v${String(s.project.history.head)}). Try again.`,
      );
    }
    const base = this.getPlan();
    if (!base) throw new AppFailure("validation", "There's no plan to edit yet.");
    // Playability findings never reject an edit: only what blocks an edit does (core's edit gate).
    const result = this.deps.core.applyChecked(base, req.ops);
    if (!result.ok) return result;
    const { version } = this.commitVersion({
      plan: result.plan,
      author: "user",
      summary: req.label,
      cause: { type: "ops", ops: req.ops },
    });
    return { ...result, version };
  }

  undo(): { head: number } {
    this.ensureNotBusy();
    const from = this.require().project.history.head;
    const head = this.moveTo((h) => history.undo(h));
    this.emitPlanChanged(from);
    return { head };
  }

  redo(): { head: number } {
    this.ensureNotBusy();
    const from = this.require().project.history.head;
    const head = this.moveTo((h) => history.redo(h));
    this.emitPlanChanged(from);
    return { head };
  }

  /**
   * Engine port (Retry, architecture §3.2): moves head back to `version`, an ancestor of head. Recorded
   * as undos (the skipped versions join `undone`), so Redo can bring the discarded turn back.
   */
  moveHead(version: number): { head: number } {
    const from = this.require().project.history.head;
    const head = this.moveTo((h) => history.moveHeadBack(h, version));
    this.emitPlanChanged(from);
    return { head };
  }

  /**
   * Head moves (undo/redo/moveHead): the new history and the new head plan are computed on copies
   * first; only if both succeed are they assigned together. A failed replay changes nothing.
   */
  private moveTo(step: (h: ProjectFile["history"]) => number): number {
    const s = this.require();
    const nextHistory = structuredClone(s.project.history);
    const n = step(nextHistory);
    const plan =
      n === 0
        ? null
        : structuredClone(history.reconstruct(nextHistory, n, this.deps.core.rules(), s.planCache));
    return this.mutate((p) => {
      p.history = nextHistory;
      p.plan = plan;
      return n;
    });
  }

  restore(version: number): { head: number } {
    this.ensureNotBusy();
    const plan = this.getPlan(version);
    if (!plan) throw new AppFailure("not_found", `Version ${String(version)} doesn't exist.`);
    const r = this.commitVersion({
      plan,
      author: "restore",
      summary: `Restored v${String(version)}`,
      cause: { type: "restore", from: version },
    });
    return { head: r.version };
  }

  getVersion(version: number): MapPlan {
    const plan = this.getPlan(version);
    if (!plan) throw new AppFailure("not_found", `Version ${String(version)} doesn't exist.`);
    return plan;
  }

  diff(from: number, to: number): PlanDiff {
    const after = this.getPlan(to);
    if (!after) throw new AppFailure("not_found", `Version ${String(to)} doesn't exist.`);
    return this.deps.core.diffPlans(from === 0 ? null : this.getPlan(from), after);
  }

  /** UX §7.5: what blocks approval is core's `planGate(issues, "approve")`. */
  approve(version: number): { approved: boolean; blocking: string[]; warnings: string[] } {
    this.ensureNotBusy();
    const plan = this.getPlan(version);
    if (!plan) throw new AppFailure("not_found", `Version ${String(version)} doesn't exist.`);
    const gate = planGate(this.deps.core.validatePlan(plan), "approve");
    const blocking = gate.blocking.map((i) => i.message);
    const warnings = gate.checks.warnings.map((i) => i.message);
    if (blocking.length > 0) return { approved: false, blocking, warnings };
    const r = approveHistory(this.require().project.history, version);
    if (!r.ok) throw new AppFailure("not_found", `Version ${String(version)} doesn't exist.`);
    this.mutate((p) => {
      p.history = r.history;
    });
    this.emitPlanChanged();
    return { approved: true, blocking, warnings };
  }

  /** Direct text edits; consecutive edits of the same element within 2 min merge into one version. */
  editText(req: IpcRequests["plan:editText"]["req"]): { head: number } {
    this.ensureNotBusy();
    for (const k of Object.keys(req.set)) {
      if (!TEXT_FIELDS.has(k)) throw new AppFailure("validation", `"${k}" isn't a text field.`);
    }
    const s = this.require();
    const h = s.project.history;
    const base = this.getPlan();
    if (!base) throw new AppFailure("validation", "There's no plan to edit yet.");
    const head = h.head === 0 ? undefined : history.findVersion(h, h.head);
    const latest = history.nextNumber(h) - 1;
    const prevOp = head?.cause.type === "ops" && head.cause.ops.length === 1 ? head.cause.ops[0] : undefined;
    const merge =
      head !== undefined &&
      head.author === "user" &&
      head.number === latest &&
      h.approvedVersion !== head.number &&
      prevOp?.op === "update" &&
      prevOp.id === req.id &&
      this.now().getTime() - Date.parse(head.createdAt) <= TEXT_MERGE_WINDOW_MS;

    const set: Record<string, unknown> = merge ? { ...prevOp.set, ...req.set } : { ...req.set };
    const op: PlanOp = { op: "update", id: req.id, set };
    const parentPlan = merge ? this.getPlan(head.parentNumber) : base;
    if (!parentPlan) throw new AppFailure("validation", "There's no plan to edit yet.");
    const plan = this.applyTextOp(parentPlan, op);
    const summary = `You edited ${Object.keys(set).join(", ")} of ${req.id}`;

    if (merge) {
      this.mutate((p) => {
        head.cause = { type: "ops", ops: [op] };
        head.summary = summary;
        head.createdAt = this.now().toISOString();
        if (head.snapshot) head.snapshot = structuredClone(plan);
        p.plan = structuredClone(plan);
      });
      s.planCache.clear();
      s.planCache.set(head.number, plan);
      this.emitPlanChanged();
      return { head: head.number };
    }
    const r = this.commitVersion({ plan, author: "user", summary, cause: { type: "ops", ops: [op] } });
    return { head: r.version };
  }

  private applyTextOp(plan: MapPlan, op: Extract<PlanOp, { op: "update" }>): MapPlan {
    const r = this.deps.core.applyChecked(plan, [op]);
    if (!r.ok) {
      const msg = r.opErrors[0]?.message ?? r.issues[0]?.message ?? "The edit was rejected.";
      throw new AppFailure("validation", msg);
    }
    return r.plan;
  }

  updateBrief(set: Partial<Record<keyof DesignBrief, unknown>>): DesignBrief {
    return this.mutate((p) => {
      const brief = { ...p.brief } as Record<string, unknown>;
      for (const [k, v] of Object.entries(set)) {
        if (v === null) Reflect.deleteProperty(brief, k);
        else if (v !== undefined) brief[k] = { value: v, source: "user" };
      }
      p.brief = brief;
      return p.brief;
    });
  }

  setBrief(brief: DesignBrief): void {
    this.mutate((p) => {
      p.brief = structuredClone(brief);
    });
  }

  // ───────────────────────────── conversation (EngineHost) ─────────────────────────────

  appendItems(conversationId: string, items: ChatItem[], meta?: Record<string, ChatMessageMeta>): void {
    this.mutate((p) => {
      const c = p.conversations.find((x) => x.id === conversationId);
      if (!c) throw new AppFailure("not_found", "Unknown conversation.");
      if (c.archived) throw new AppFailure("validation", "That conversation is read-only.");
      c.items.push(...structuredClone(items));
      if (meta) Object.assign(c.meta, structuredClone(meta));
    });
  }

  updateConversation(conversationId: string, fn: (c: Conversation) => void): void {
    this.mutate((p) => {
      const c = p.conversations.find((x) => x.id === conversationId);
      if (!c) throw new AppFailure("not_found", "Unknown conversation.");
      fn(c);
    });
  }

  newConversation(selection: ModelSelection | undefined): ProjectSnapshot {
    this.ensureNotBusy();
    this.mutate((p) => {
      const current = activeConversation(p);
      current.archived = true;
      const c = newConversation(
        selection ?? current.selection,
        this.convDefaults(selection ?? current.selection),
        this.now().toISOString(),
      );
      p.conversations.push(c);
      p.activeConversationId = c.id;
    });
    return this.snapshot();
  }

  addSpend(usage: Usage, cost: Cost | null): void {
    this.mutate((p) => {
      const u = p.spend.usage;
      u.inputTokens += usage.inputTokens;
      u.outputTokens += usage.outputTokens;
      u.cacheReadTokens += usage.cacheReadTokens;
      u.cacheWriteTokens += usage.cacheWriteTokens;
      if (cost)
        p.spend.cost = {
          currency: "USD",
          amount: (p.spend.cost?.amount ?? 0) + cost.amount,
          estimated: true,
        };
    });
  }

  // ───────────────────────────── builds, export state, resume state ─────────────────────────────

  addBuild(record: BuildRecord): void {
    this.mutate((p) => {
      p.builds.push(record);
      if (p.builds.length > 20) p.builds.splice(0, p.builds.length - 20);
    });
  }

  setPasted(buildId: string, chunkId: string, pasted: boolean): void {
    this.mutate((p) => {
      const build = p.builds.find((b) => b.id === buildId);
      const chunk = build?.levels.flatMap((l) => l.chunks).find((c) => c.id === chunkId);
      if (!build || !chunk) throw new AppFailure("not_found", "That chunk isn't part of this build.");
      chunk.pasted = pasted;
      if (pasted && chunk.copiedAt === undefined) chunk.copiedAt = this.now().toISOString();
    });
  }

  /** Copy tracking (clipboard:writeText / talespire:copyAndOpen with `chunk`). False when the chunk is unknown. */
  markCopied(buildId: string, chunkId: string): boolean {
    const build = this.require().project.builds.find((b) => b.id === buildId);
    if (!build?.levels.some((l) => l.chunks.some((c) => c.id === chunkId))) return false;
    this.mutate(() => {
      for (const l of build.levels)
        for (const c of l.chunks) if (c.id === chunkId) c.copiedAt = this.now().toISOString();
    });
    return true;
  }

  findBuild(buildId: string): BuildRecord {
    const b = this.require().project.builds.find((x) => x.id === buildId);
    if (!b) throw new AppFailure("not_found", "That build no longer exists.");
    return b;
  }

  /** Resume state (UX §8.9), channel project:setUiState: ui is shallow-merged; pasteGuide null clears it. */
  setUiState(patch: {
    ui?: Partial<ProjectFile["ui"]>;
    pasteGuide?: ProjectFile["pasteGuide"] | null;
    pngExport?: NonNullable<ProjectFile["pngExport"]>;
  }): void {
    this.mutate((p) => {
      if (patch.pngExport !== undefined) p.pngExport = structuredClone(patch.pngExport);
      if (patch.ui) p.ui = { ...p.ui, ...patch.ui, lastActivityAt: this.now().toISOString() };
      if (patch.pasteGuide === null) delete p.pasteGuide;
      else if (patch.pasteGuide !== undefined) p.pasteGuide = patch.pasteGuide;
    });
  }

  setPngExport(value: NonNullable<ProjectFile["pngExport"]>): void {
    this.mutate((p) => {
      p.pngExport = value;
    });
  }

  setThumbnail(levelId: LevelId, version: number, pngBase64: string): void {
    this.mutate((p) => {
      p.thumbnail = { levelId, version, pngBase64 };
    });
  }

  thumbnailTarget(): { levelId: LevelId; version: number } | null {
    const p = this.state?.project;
    if (!p?.plan || p.history.head === 0) return null;
    if (p.thumbnail && p.thumbnail.version === p.history.head) return null;
    const levelId = p.ui.levelId ?? p.plan.entryLevel ?? p.plan.levels[0]?.id;
    return levelId === undefined ? null : { levelId, version: p.history.head };
  }
}

export function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}
