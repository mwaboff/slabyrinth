import type { AssetCatalog, MapPlan } from "@slabyrinth/core";
import type { ShotName } from "@slabyrinth/scene3d";
import type { IpcRequests, View3dHeader } from "../../../shared/ipc";
import type { ProjectFile } from "../../../shared/project";
import { VIEW3D_LIMITS } from "../../../shared/schemas/ipc";
import type { MeshesApi, View3dApi } from "../../ipc/view3dHandlers";
import type { Logger } from "../../logger";
import { DeadlineExceeded, withDeadline } from "../../util/deadline";
import { AppFailure } from "../../util/errors";
import type {
  BuiltScene,
  SceneJob,
  SceneWorkerRequest,
  SceneWorkerResponse,
} from "../../workers/sceneProtocol";
import type { EmitEvent } from "../events";
import type { MeshService } from "../meshes/meshService";
import { isOutOfMemory, type WorkerPort } from "../meshes/workerPort";

/**
 * View3dService: the 3D view's scenes and the model's 3D pictures (design render-tools §4.5, §5.3), served by one
 * scene worker. Nothing heavy runs on the main thread. A window has one scene at a time (opening another releases
 * it); the model's pictures use a scene of their own for the head version. Every request has a deadline; a scene
 * being laid out can be cancelled (the worker is stopped, and every scene it held is gone). A worker that runs out of
 * memory lays the scene out once more with boxes only, and says so.
 */
export const TOO_BIG = "This map is too big to show in 3D on this PC; showing boxes.";
/** Decoded game shapes a scene may hold (design §2.7: decoded mesh LRU ≤ 192 MB). */
export const MESH_BUDGET_BYTES = 192 * 1024 * 1024;
const DEFAULT_DEADLINES = { buildMs: 180_000, requestMs: 60_000 };

/** The model's pictures: request and result as the tools contract has them (core agent/toolContract.ts). */
export interface Render3dArgs {
  shots?: ShotName[];
  max?: number;
}
export interface Render3dOut {
  png: Uint8Array;
  captions: string[];
  suggestions: string;
}

export interface View3dDeps {
  spawn: () => WorkerPort<SceneWorkerRequest, SceneWorkerResponse>;
  projects: {
    readonly isOpen: boolean;
    getProject(): Readonly<ProjectFile> | null;
    getPlan(version?: number): MapPlan | null;
  };
  /** The build's inputs (palette files, orientation, the scanned catalog), as builds get them. */
  inputs: () => {
    userPalettes: Array<{ source: string; data: unknown }>;
    orientationOverride: unknown;
    catalog: AssetCatalog | null;
  };
  meshes: Pick<MeshService, "sceneMeshes" | "warm" | "noteScene" | "info" | "rebuild" | "clear">;
  emit: EmitEvent;
  logger: Logger;
  meshBudgetBytes?: number;
  deadlines?: Partial<typeof DEFAULT_DEADLINES>;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

interface Pending {
  resolve: (r: SceneWorkerResponse) => void;
  reject: (e: Error) => void;
  progress?: (done: number, total: number) => void;
}

interface SceneRec {
  version: number;
  buildId: string | null;
  owner: "view" | "model";
  /** The plan's identity when laid out (a different plan at the same version number is laid out again). */
  planKey: string;
}

export class View3dService implements View3dApi {
  private worker: WorkerPort<SceneWorkerRequest, SceneWorkerResponse> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly scenes = new Map<string, SceneRec>();
  private seq = 0;
  private sceneSeq = 0;
  /** The view scene being laid out now (view3d:cancel stops it). */
  private building: { sceneId: string; cancel: () => void } | null = null;
  private viewScene: string | null = null;
  private modelScene: string | null = null;
  private readonly deadlines: typeof DEFAULT_DEADLINES;

  constructor(private readonly deps: View3dDeps) {
    this.deadlines = { ...DEFAULT_DEADLINES, ...deps.deadlines };
  }

  /** The piece cache's channels (they live in MeshService; the IPC wiring takes both from here). */
  get meshesApi(): MeshesApi {
    const m = this.deps.meshes;
    return { info: () => m.info(), rebuild: () => m.rebuild(), clear: () => m.clear() };
  }

  // ───────────── worker plumbing ─────────────

  private ensureWorker(): WorkerPort<SceneWorkerRequest, SceneWorkerResponse> {
    if (this.worker) return this.worker;
    const w = this.deps.spawn();
    this.worker = w;
    w.on("message", (r: SceneWorkerResponse) => {
      const p = this.pending.get(r.id);
      if (!p) return;
      if (r.type === "progress") {
        p.progress?.(r.done, r.total);
        return;
      }
      this.pending.delete(r.id);
      if (r.type === "error")
        p.reject(
          new AppFailure(r.code ?? "internal", r.code ? r.message : `The 3D view failed: ${r.message}`),
        );
      else p.resolve(r);
    });
    const dead = (err: Error): void => {
      if (this.worker !== w) return;
      this.dropWorker(err);
    };
    w.on("error", (err: Error) => {
      this.deps.logger.error("scene worker crashed", { error: err });
      dead(isOutOfMemory(err) ? new OutOfMemory() : err);
    });
    w.on("exit", (code: number) => {
      dead(isOutOfMemory(code) ? new OutOfMemory() : new Error(`scene worker exit ${String(code)}`));
    });
    return w;
  }

  /** Stops the worker: every request in flight fails with `err`, every scene it held is gone. */
  private dropWorker(err: Error): void {
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate().catch(() => undefined);
    const all = [...this.pending.values()];
    this.pending.clear();
    this.scenes.clear();
    this.viewScene = null;
    this.modelScene = null;
    for (const p of all) p.reject(err);
  }

  private request(
    msg: WithoutId<SceneWorkerRequest>,
    ms: number,
    signal?: AbortSignal,
    progress?: (done: number, total: number) => void,
  ): Promise<SceneWorkerResponse> {
    const id = ++this.seq;
    const deadline = withDeadline(signal, ms);
    return new Promise<SceneWorkerResponse>((resolve, reject) => {
      const done = (): void => {
        deadline.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (!this.pending.has(id)) return;
        // a job cannot be interrupted inside the worker: stop the worker (the next request starts a new one)
        this.dropWorker(
          deadline.reason instanceof DeadlineExceeded
            ? new AppFailure("internal", "The 3D view didn't answer in time.")
            : new AppFailure("cancelled", "Stopped."),
        );
      };
      this.pending.set(id, {
        resolve: (r) => {
          done();
          resolve(r);
        },
        reject: (e) => {
          done();
          reject(e);
        },
        ...(progress ? { progress } : {}),
      });
      if (deadline.aborted) {
        onAbort();
        return;
      }
      deadline.addEventListener("abort", onAbort, { once: true });
      this.ensureWorker().postMessage({ ...msg, id });
    });
  }

  // ───────────── scenes ─────────────

  private planAt(req: { version?: number; buildId?: string }): {
    version: number;
    buildId: string | null;
    plan: MapPlan;
  } {
    const project = this.deps.projects.getProject();
    if (!project) throw new AppFailure("no_project", "No map is open.");
    let version = req.version ?? project.history.head;
    let buildId: string | null = null;
    if (req.buildId !== undefined) {
      const b = project.builds.find((x) => x.id === req.buildId);
      if (!b) throw new AppFailure("not_found", "That build isn't in this map.");
      version = b.versionNumber;
      buildId = b.id;
    }
    if (version === 0) throw new AppFailure("validation", "There's no plan to show yet.");
    const plan = this.deps.projects.getPlan(version);
    if (!plan) throw new AppFailure("not_found", `There's no version v${String(version)}.`);
    return { version, buildId, plan };
  }

  private previousOf(version: number): MapPlan | null {
    const v = this.deps.projects.getProject()?.history.versions.find((x) => x.number === version);
    const parent = v?.parentNumber ?? version - 1;
    return parent > 0 ? this.deps.projects.getPlan(parent) : null;
  }

  /** Lays out a scene (once more with boxes only if the worker runs out of memory). */
  private async build(
    sceneId: string,
    plan: MapPlan,
    previous: MapPlan | null,
    signal: AbortSignal | undefined,
    progress: (done: number, total: number) => void,
  ): Promise<BuiltScene> {
    const inputs = this.deps.inputs();
    const job: SceneJob = {
      sceneId,
      plan,
      previous,
      userPalettes: inputs.userPalettes,
      orientationOverride: inputs.orientationOverride,
      catalog: inputs.catalog,
      meshes: await this.deps.meshes.sceneMeshes(),
      meshBudgetBytes: this.deps.meshBudgetBytes ?? MESH_BUDGET_BYTES,
    };
    const run = async (j: SceneJob): Promise<BuiltScene> => {
      const r = await this.request({ type: "build", job: j }, this.deadlines.buildMs, signal, progress);
      if (r.type !== "built") throw new AppFailure("internal", "Unexpected 3D reply.");
      return r.scene;
    };
    try {
      return await run(job);
    } catch (err) {
      if (!(err instanceof OutOfMemory)) throw err;
      this.deps.logger.warn("scene worker out of memory; laying the scene out with boxes only", {});
      const scene = await run({
        ...job,
        meshes: { mode: "boxes", reason: "boxes-requested" },
        meshBudgetBytes: 0,
      }).catch((e: unknown) => {
        throw e instanceof OutOfMemory ? new AppFailure("internal", TOO_BIG) : e;
      });
      return { ...scene, limited: TOO_BIG };
    }
  }

  private planKey(plan: MapPlan): string {
    return `${plan.id}:${String(plan.seed)}:${String(plan.generator)}`;
  }

  async open(req: IpcRequests["view3d:open"]["req"]): Promise<View3dHeader> {
    const { version, buildId, plan } = this.planAt(req);
    // one scene per window: the previous one goes
    if (this.viewScene !== null) await this.close(this.viewScene);
    this.building?.cancel();
    const sceneId = `s${String(++this.sceneSeq)}`;
    const abort = new AbortController();
    this.building = {
      sceneId,
      cancel: () => {
        abort.abort();
      },
    };
    const mine = this.building;
    let built: BuiltScene;
    try {
      built = await this.build(sceneId, plan, this.previousOf(version), abort.signal, (done, total) => {
        this.deps.emit("view3d:progress", { sceneId, stage: "layout", done, total });
      });
    } finally {
      // a later open may have replaced it meanwhile
      if (this.building === mine) this.building = null;
    }
    this.scenes.set(sceneId, { version, buildId, owner: "view", planKey: this.planKey(plan) });
    this.viewScene = sceneId;
    this.deps.meshes.noteScene(built.header.counts.boxes, built.uuids);
    this.deps.logger.info("3d scene laid out", {
      instances: built.header.counts.instances,
      boxes: built.header.counts.boxes,
      pending: built.pending.length,
      ms: built.ms,
    });
    if (built.pending.length > 0) {
      const total = built.pending.length;
      void this.deps.meshes
        .warm(built.pending, (done, bundles) => {
          // bundles read so far, as a share of the pieces waiting (done === total only once all are read)
          const d = Math.min(total - 1, Math.floor((done / Math.max(1, bundles)) * total));
          this.deps.emit("view3d:progress", { sceneId, stage: "detail", done: d, total });
        })
        .then(() => {
          this.deps.emit("view3d:progress", { sceneId, stage: "detail", done: total, total });
        });
    }
    return {
      ...built.header,
      sceneId,
      version,
      buildId,
      pendingDetail: built.pending.length,
      limited: built.limited,
    };
  }

  private known(sceneId: string): void {
    if (!this.scenes.has(sceneId)) throw new AppFailure("not_found", "That 3D view was closed.");
  }

  async chunks(req: IpcRequests["view3d:chunks"]["req"]): Promise<IpcRequests["view3d:chunks"]["res"]> {
    this.known(req.sceneId);
    const r = await this.request(
      { type: "chunks", sceneId: req.sceneId, ids: req.chunkIds, capBytes: VIEW3D_LIMITS.replyBytes },
      this.deadlines.requestMs,
    );
    if (r.type !== "chunks") throw new AppFailure("internal", "Unexpected 3D reply.");
    return { chunks: r.chunks, more: r.more };
  }

  async meshes(req: IpcRequests["view3d:meshes"]["req"]): Promise<IpcRequests["view3d:meshes"]["res"]> {
    this.known(req.sceneId);
    const r = await this.request(
      { type: "meshes", sceneId: req.sceneId, keys: req.keys, capBytes: VIEW3D_LIMITS.replyBytes },
      this.deadlines.requestMs,
    );
    if (r.type !== "meshes") throw new AppFailure("internal", "Unexpected 3D reply.");
    return { meshes: r.meshes, more: r.more };
  }

  async shot(req: IpcRequests["view3d:shot"]["req"]): Promise<IpcRequests["view3d:shot"]["res"]> {
    this.known(req.sceneId);
    const r = await this.request(
      { type: "shot", sceneId: req.sceneId, shot: req.shot, width: req.width, height: req.height },
      this.deadlines.requestMs,
    );
    if (r.type !== "shot") throw new AppFailure("internal", "Unexpected 3D reply.");
    return { png: r.png, caption: r.caption };
  }

  cancel(sceneId: string | undefined): void {
    if (this.building && (sceneId === undefined || this.building.sceneId === sceneId)) this.building.cancel();
  }

  async close(sceneId: string): Promise<void> {
    if (!this.scenes.delete(sceneId)) return;
    if (this.viewScene === sceneId) this.viewScene = null;
    if (this.modelScene === sceneId) this.modelScene = null;
    if (!this.worker) return;
    await this.request({ type: "release", sceneId }, this.deadlines.requestMs).catch(() => undefined);
  }

  // ───────────── the model's pictures ─────────────

  /**
   * One sheet of 3D views of the head version for the model's tools (ToolContext.render3d): the views named, or the
   * ranked rules' choice, at most `max` (1..4). The scene is kept for the next call while the version stays the head.
   */
  async render3d(req: Render3dArgs, signal?: AbortSignal): Promise<Render3dOut> {
    const { version, plan } = this.planAt({});
    const key = this.planKey(plan);
    const old = this.modelScene;
    let sceneId = old ?? "";
    const rec = old === null ? undefined : this.scenes.get(old);
    if (!rec || rec.version !== version || rec.planKey !== key) {
      if (old !== null) await this.close(old);
      sceneId = `m${String(++this.sceneSeq)}`;
      const built = await this.build(sceneId, plan, this.previousOf(version), signal, () => undefined);
      this.scenes.set(sceneId, { version, buildId: null, owner: "model", planKey: key });
      this.modelScene = sceneId;
      // the shapes not read yet are boxes in these pictures; read them for the next look
      if (built.pending.length > 0) void this.deps.meshes.warm(built.pending);
    }
    const r = await this.request(
      {
        type: "pictures",
        sceneId,
        ...(req.shots ? { shots: req.shots } : {}),
        ...(req.max !== undefined ? { max: req.max } : {}),
      },
      this.deadlines.requestMs,
      signal,
    );
    if (r.type !== "pictures") throw new AppFailure("internal", "Unexpected 3D reply.");
    return { png: r.png, captions: r.captions, suggestions: r.suggestions };
  }

  /**
   * The packaged-app smoke check: lays out `plan` with boxes in the scene worker and renders its overview (proves the
   * worker loads from the app's bundle). Returns the counts; the scene is released.
   */
  async selfCheck(plan: MapPlan): Promise<{ instances: number; chunks: number; pngBytes: number }> {
    const sceneId = `check${String(++this.sceneSeq)}`;
    const inputs = this.deps.inputs();
    const r = await this.request(
      {
        type: "build",
        job: {
          sceneId,
          plan,
          previous: null,
          userPalettes: inputs.userPalettes,
          orientationOverride: inputs.orientationOverride,
          catalog: inputs.catalog,
          meshes: { mode: "boxes", reason: "boxes-requested" },
          meshBudgetBytes: 0,
        },
      },
      this.deadlines.buildMs,
    );
    if (r.type !== "built") throw new AppFailure("internal", "Unexpected 3D reply.");
    const shot = await this.request(
      { type: "shot", sceneId, shot: "overview", width: 256, height: 192 },
      this.deadlines.requestMs,
    );
    await this.request({ type: "release", sceneId }, this.deadlines.requestMs);
    if (shot.type !== "shot") throw new AppFailure("internal", "Unexpected 3D reply.");
    return {
      instances: r.scene.header.counts.instances,
      chunks: r.scene.header.chunks.length,
      pngBytes: shot.png.length,
    };
  }

  /** Stops the worker (app shutdown). */
  dispose(): void {
    this.dropWorker(new AppFailure("cancelled", "Slabyrinth is closing."));
  }
}

class OutOfMemory extends Error {
  constructor() {
    super("out of memory");
    this.name = "OutOfMemory";
  }
}
