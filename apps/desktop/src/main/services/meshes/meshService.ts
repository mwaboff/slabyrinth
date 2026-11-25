import type { MeshCacheInfo } from "../../../shared/ipc";
import type { Logger } from "../../logger";
import { AppFailure } from "../../util/errors";
import type { MeshWorkerRequest, MeshWorkerResponse } from "../../workers/meshProtocol";
import type { EmitEvent } from "../events";
import { cacheStats, clearMeshCache } from "./diskCache";
import type { WorkerPort } from "./workerPort";

/**
 * MeshService: the 3D piece cache (design render-tools §2.4, §4.6). Scenes are laid out from the cache alone (the scene
 * worker never reads the game cold); pieces not in it are boxes ("not read yet") while this service reads their
 * shapes from the user's TaleSpire install in its own worker, one job at a time, and says so ("meshes:status").
 * With 3D turned off in Settings, or no install found, nothing is read and every piece is a box of its real size.
 * The cache lives in the app's data folder (userData/meshes), is never sent anywhere and never bundled.
 */
export const MESH_CACHE_LIMIT_BYTES = 512 * 1024 * 1024;

/** Where a scene's pieces' shapes come from. */
export type SceneMeshes =
  | { mode: "cache"; installPath: string; cacheDir: string; limitBytes: number }
  | { mode: "boxes"; reason: "boxes-requested" | "no-install" };

export interface MeshServiceDeps {
  cacheDir: string;
  limitBytes?: number;
  /** The TaleSpire install in use (settings or found), or null. */
  installPath: () => Promise<string | null>;
  /** 3D on in Settings (AppSettings.agent.view3d). */
  enabled: () => boolean;
  spawn: () => WorkerPort<MeshWorkerRequest, MeshWorkerResponse>;
  emit: EmitEvent;
  logger: Logger;
}

const WORDS = {
  off: "3D is turned off in Settings, so every piece shows as a box of its real size and nothing is read from TaleSpire.",
  noInstall:
    "TaleSpire isn't installed on this PC (or Slabyrinth can't find it), so every piece shows as a box of its real size.",
  reading:
    "Reading TaleSpire's pieces (once after each game update). Pieces show as boxes until they're read.",
};

export class MeshService {
  private readonly limitBytes: number;
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private running: { worker: WorkerPort<MeshWorkerRequest, MeshWorkerResponse>; stop: () => void } | null =
    null;
  private pending = 0;
  private seq = 0;
  private lastBoxes = 0;
  private lastUuids: string[] = [];

  constructor(private readonly deps: MeshServiceDeps) {
    this.limitBytes = deps.limitBytes ?? MESH_CACHE_LIMIT_BYTES;
  }

  get extracting(): boolean {
    return this.pending > 0;
  }

  /** Where the next scene's shapes come from. */
  async sceneMeshes(): Promise<SceneMeshes> {
    if (!this.deps.enabled()) return { mode: "boxes", reason: "boxes-requested" };
    const installPath = await this.deps.installPath();
    if (installPath === null) return { mode: "boxes", reason: "no-install" };
    return { mode: "cache", installPath, cacheDir: this.deps.cacheDir, limitBytes: this.limitBytes };
  }

  /** A scene was laid out: how many pieces it showed as boxes, and which asset ids it holds (for "Read again"). */
  noteScene(boxes: number, uuids: readonly string[]): void {
    this.lastBoxes = boxes;
    this.lastUuids = [...uuids];
    void this.announce();
  }

  /**
   * Reads these pieces' shapes into the cache in the background (after any read already queued). Resolves when they
   * are read (or could not be); never rejects. Nothing happens with 3D off or no install.
   */
  warm(uuids: readonly string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const list = [...new Set(uuids)].sort();
    // nothing to read: resolves when the reads already queued are done
    if (list.length === 0) return this.tail;
    const gen = this.generation;
    this.pending++;
    void this.announce();
    const job = this.tail.then(async () => {
      if (gen !== this.generation) return;
      const where = await this.sceneMeshes();
      if (where.mode !== "cache") return;
      await this.run(where, list, onProgress).catch((err: unknown) => {
        this.deps.logger.warn("reading pieces' shapes failed", { error: err });
      });
    });
    this.tail = job.finally(() => {
      this.pending--;
      void this.announce();
    });
    return this.tail;
  }

  private run(
    where: Extract<SceneMeshes, { mode: "cache" }>,
    uuids: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const id = ++this.seq;
    const worker = this.deps.spawn();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (this.running?.worker === worker) this.running = null;
        void worker.terminate().catch(() => undefined);
        fn();
      };
      this.running = {
        worker,
        stop: () => {
          finish(resolve);
        },
      };
      worker.on("message", (r: MeshWorkerResponse) => {
        if (r.id !== id) return;
        if (r.type === "progress") onProgress?.(r.done, r.total);
        else if (r.type === "read") {
          this.deps.logger.info("pieces' shapes read", { read: r.read, failed: r.failed, bytes: r.bytes });
          finish(resolve);
        } else
          finish(() => {
            reject(new Error(r.message));
          });
      });
      worker.on("error", (err: Error) => {
        finish(() => {
          reject(err);
        });
      });
      worker.on("exit", (code: number) => {
        finish(() => {
          reject(new Error(`mesh worker exit ${String(code)}`));
        });
      });
      worker.postMessage({ type: "read", id, ...where, uuids });
    });
  }

  /** Stops reading and drops queued reads (nothing is left half-written: files are renamed into place). */
  cancel(): void {
    this.generation++;
    this.running?.stop();
  }

  async info(): Promise<MeshCacheInfo> {
    const stats = await cacheStats(this.deps.cacheDir);
    const where = await this.sceneMeshes();
    const state: MeshCacheInfo["state"] =
      where.mode === "boxes"
        ? where.reason === "no-install"
          ? "no_install"
          : "off"
        : this.extracting
          ? "reading"
          : "ready";
    const message =
      state === "off"
        ? WORDS.off
        : state === "no_install"
          ? WORDS.noInstall
          : state === "reading"
            ? WORDS.reading
            : `${String(stats.files)} pieces read from TaleSpire${this.lastBoxes > 0 ? `; ${String(this.lastBoxes)} shown as boxes in the last 3D view` : ""}. Kept on this PC only.`;
    return {
      state,
      read: stats.files,
      boxes: this.lastBoxes,
      extracting: this.extracting,
      bytes: stats.bytes,
      limitBytes: this.limitBytes,
      message,
    };
  }

  private async announce(): Promise<void> {
    try {
      const stats = await cacheStats(this.deps.cacheDir);
      this.deps.emit("meshes:status", {
        read: stats.files,
        boxes: this.lastBoxes,
        extracting: this.extracting,
        bytes: stats.bytes,
      });
    } catch (err) {
      this.deps.logger.warn("piece cache status failed", { error: err });
    }
  }

  /** "Clear": stops reading, deletes the app's own cache folder (refused when it isn't plainly ours). */
  async clear(): Promise<MeshCacheInfo> {
    this.cancel();
    await this.tail.catch(() => undefined);
    const r = await clearMeshCache(this.deps.cacheDir);
    if (!r.ok) {
      this.deps.logger.warn("piece cache not cleared", { reason: r.reason });
      throw new AppFailure("validation", r.reason);
    }
    this.deps.logger.info("piece cache cleared", { removed: r.removed });
    await this.announce();
    return this.info();
  }

  /** "Read again": clears the cache, then reads the last 3D view's pieces again in the background. */
  async rebuild(): Promise<MeshCacheInfo> {
    await this.clear();
    void this.warm(this.lastUuids);
    return this.info();
  }
}
