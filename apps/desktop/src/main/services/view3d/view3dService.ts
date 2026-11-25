import type { AssetCatalog, MapPlan } from "@slabyrinth/core";
import type { ShotName } from "@slabyrinth/scene3d";
import type { IpcRequests, View3dHeader } from "../../../shared/ipc";
import type { ProjectFile } from "../../../shared/project";
import { VIEW3D_LIMITS } from "../../../shared/schemas/ipc";
import type { MeshesApi, View3dApi } from "../../ipc/view3dHandlers";
import type { Logger } from "../../logger";
import { AppFailure } from "../../util/errors";
import type { BuiltScene, SceneJob, SceneWorkerResponse } from "../../workers/sceneProtocol";
import type { EmitEvent } from "../events";
import type { MeshService } from "../meshes/meshService";
import { OutOfMemory, SceneLane, type ScenePort } from "./sceneLane";

/**
 * View3dService: the 3D view's scenes and the model's 3D pictures (design render-tools §4.5, §5.3). Nothing heavy runs
 * on the main thread. Each owner has its own scene worker (a SceneLane): the 3D tab's ("view") and the model's
 * pictures' ("model"), so one owner's cancel, deadline or crash never costs the other its scene. Deadlines count a
 * job's running time, not its time queued.
 *
 * The window shows one scene; opening another hands over: the scene it shows stays served until the window closes it
 * (it does once the new header is in its hands), and any other view scene goes when an open completes. The model's
 * pictures keep one scene for the head version. A worker that runs out of memory lays the scene out once more with
 * boxes only, and says so.
 *
 * Pieces not in the cache yet are read in the background and the window opens the scene again when "detail" is done.
 * A target's pieces are read once: an open that finds only pieces its target's last read already tried (they could
 * not be read, or did not stay in the cache) reads nothing and reports no detail pending, so nothing loops.
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

/** Who a scene worker serves: the 3D tab, the model's pictures, or the packaged-app self check. */
export type SceneOwner = "view" | "model" | "check";

export interface View3dDeps {
  /** A new scene worker (one per owner; each has its own heap limit). */
  spawn: (owner: SceneOwner) => ScenePort;
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

interface SceneRec {
  version: number;
  buildId: string | null;
  owner: SceneOwner;
  /** The plan's identity when laid out (a different plan at the same version number is laid out again). */
  planKey: string;
}

export class View3dService implements View3dApi {
  private readonly lanes: Record<SceneOwner, SceneLane>;
  private readonly scenes = new Map<string, SceneRec>();
  private sceneSeq = 0;
  /** The view scene being laid out now (view3d:cancel stops it). */
  private building: { sceneId: string; cancel: () => void } | null = null;
  /** The view scene the window was last given: it stays served until the window closes it. */
  private viewShown: string | null = null;
  private modelScene: string | null = null;
  /** The view target whose pieces were read last, and every piece those reads tried. */
  private lastRead: { key: string; tried: Set<string> } | null = null;
  private readonly deadlines: typeof DEFAULT_DEADLINES;

  constructor(private readonly deps: View3dDeps) {
    this.deadlines = { ...DEFAULT_DEADLINES, ...deps.deadlines };
    const lane = (owner: SceneOwner): SceneLane =>
      new SceneLane(
        owner,
        () => deps.spawn(owner),
        deps.logger,
        () => {
          this.lost(owner);
        },
      );
    this.lanes = { view: lane("view"), model: lane("model"), check: lane("check") };
  }

  /** The piece cache's channels (they live in MeshService; the IPC wiring takes both from here). */
  get meshesApi(): MeshesApi {
    const m = this.deps.meshes;
    return {
      info: () => m.info(),
      // a cleared cache is read again from scratch
      rebuild: () => {
        this.lastRead = null;
        return m.rebuild();
      },
      clear: () => {
        this.lastRead = null;
        return m.clear();
      },
    };
  }

  /** An owner's worker stopped: its scenes are gone (the window's next request says "not_found" and it reopens). */
  private lost(owner: SceneOwner): void {
    for (const [id, rec] of this.scenes) if (rec.owner === owner) this.scenes.delete(id);
    if (owner === "view") this.viewShown = null;
    if (owner === "model") this.modelScene = null;
  }

  private laneOf(sceneId: string): SceneLane {
    const rec = this.scenes.get(sceneId);
    if (!rec) throw new AppFailure("not_found", "That 3D view was closed.");
    return this.lanes[rec.owner];
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

  /** Lays out a scene in its owner's worker (once more with boxes only if the worker runs out of memory). */
  private async build(
    owner: SceneOwner,
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
      const r = await this.lanes[owner].request(
        { type: "build", job: j },
        this.deadlines.buildMs,
        signal,
        progress,
      );
      if (r.type !== "built") throw new AppFailure("internal", "Unexpected 3D reply.");
      return r.scene;
    };
    try {
      return await run(job);
    } catch (err) {
      if (!(err instanceof OutOfMemory)) throw err;
      this.deps.logger.warn("scene worker out of memory; laying the scene out with boxes only", { owner });
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

  /** The pending pieces to read for a view target: those its last read has not tried yet. */
  private toRead(key: string, pending: readonly string[]): string[] {
    const tried = this.lastRead?.key === key ? this.lastRead.tried : null;
    return tried ? pending.filter((u) => !tried.has(u)) : [...pending];
  }

  private noteRead(key: string, uuids: readonly string[]): void {
    if (this.lastRead?.key !== key) this.lastRead = { key, tried: new Set() };
    for (const u of uuids) this.lastRead.tried.add(u);
  }

  async open(req: IpcRequests["view3d:open"]["req"]): Promise<View3dHeader> {
    const { version, buildId, plan } = this.planAt(req);
    // a newer open replaces a layout still running for the window
    this.building?.cancel();
    // the scene the window shows now stays served until it has the new header (it closes it itself)
    const shown = this.viewShown;
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
      built = await this.build(
        "view",
        sceneId,
        plan,
        this.previousOf(version),
        abort.signal,
        (done, total) => {
          this.deps.emit("view3d:progress", { sceneId, stage: "layout", done, total });
        },
      );
    } finally {
      // a later open may have replaced it meanwhile
      if (this.building === mine) this.building = null;
    }
    for (const [id, rec] of [...this.scenes]) if (rec.owner === "view" && id !== shown) await this.close(id);
    this.scenes.set(sceneId, { version, buildId, owner: "view", planKey: this.planKey(plan) });
    this.viewShown = sceneId;
    this.deps.meshes.noteScene(built.header.counts.boxes, built.uuids);
    const key = `${this.planKey(plan)}@v${String(version)}`;
    const reading = this.toRead(key, built.pending);
    this.deps.logger.info("3d scene laid out", {
      instances: built.header.counts.instances,
      boxes: built.header.counts.boxes,
      pending: built.pending.length,
      reading: reading.length,
      ms: built.ms,
    });
    if (reading.length > 0) {
      const total = reading.length;
      void this.deps.meshes
        .warm(reading, (done, bundles) => {
          // bundles read so far, as a share of the pieces waiting (done === total only once all are read)
          const d = Math.min(total - 1, Math.floor((done / Math.max(1, bundles)) * total));
          this.deps.emit("view3d:progress", { sceneId, stage: "detail", done: d, total });
        })
        .then(() => {
          this.noteRead(key, reading);
          this.deps.emit("view3d:progress", { sceneId, stage: "detail", done: total, total });
        });
    }
    return {
      ...built.header,
      sceneId,
      version,
      buildId,
      pendingDetail: reading.length,
      limited: built.limited,
    };
  }

  async chunks(req: IpcRequests["view3d:chunks"]["req"]): Promise<IpcRequests["view3d:chunks"]["res"]> {
    const r = await this.laneOf(req.sceneId).request(
      { type: "chunks", sceneId: req.sceneId, ids: req.chunkIds, capBytes: VIEW3D_LIMITS.replyBytes },
      this.deadlines.requestMs,
    );
    if (r.type !== "chunks") throw new AppFailure("internal", "Unexpected 3D reply.");
    return { chunks: r.chunks, more: r.more };
  }

  async meshes(req: IpcRequests["view3d:meshes"]["req"]): Promise<IpcRequests["view3d:meshes"]["res"]> {
    const r = await this.laneOf(req.sceneId).request(
      { type: "meshes", sceneId: req.sceneId, keys: req.keys, capBytes: VIEW3D_LIMITS.replyBytes },
      this.deadlines.requestMs,
    );
    if (r.type !== "meshes") throw new AppFailure("internal", "Unexpected 3D reply.");
    return { meshes: r.meshes, more: r.more };
  }

  async shot(req: IpcRequests["view3d:shot"]["req"]): Promise<IpcRequests["view3d:shot"]["res"]> {
    const r = await this.laneOf(req.sceneId).request(
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
    const rec = this.scenes.get(sceneId);
    if (!rec) return;
    this.scenes.delete(sceneId);
    if (this.viewShown === sceneId) this.viewShown = null;
    if (this.modelScene === sceneId) this.modelScene = null;
    const lane = this.lanes[rec.owner];
    if (!lane.alive) return;
    await lane.request({ type: "release", sceneId }, this.deadlines.requestMs).catch(() => undefined);
  }

  // ───────────── the model's pictures ─────────────

  /**
   * One sheet of 3D views of the head version for the model's tools (ToolContext.render3d): the views named, or the
   * ranked rules' choice, at most `max` (1..4). The scene is kept for the next call while the version stays the head.
   * Runs in the model's own worker: `signal` (Stop in chat) never touches the 3D tab's scene.
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
      const built = await this.build(
        "model",
        sceneId,
        plan,
        this.previousOf(version),
        signal,
        () => undefined,
      );
      this.scenes.set(sceneId, { version, buildId: null, owner: "model", planKey: key });
      this.modelScene = sceneId;
      // the shapes not read yet are boxes in these pictures; read them for the next look
      if (built.pending.length > 0) void this.deps.meshes.warm(built.pending);
    }
    const r = await this.lanes.model.request(
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
   * The packaged-app smoke check: lays out `plan` with boxes in a scene worker of its own and renders its overview
   * (proves the worker loads from the app's bundle). Returns the counts; the worker is stopped afterwards.
   */
  async selfCheck(plan: MapPlan): Promise<{ instances: number; chunks: number; pngBytes: number }> {
    const lane = this.lanes.check;
    const sceneId = `check${String(++this.sceneSeq)}`;
    const inputs = this.deps.inputs();
    try {
      const r: SceneWorkerResponse = await lane.request(
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
      const shot = await lane.request(
        { type: "shot", sceneId, shot: "overview", width: 256, height: 192 },
        this.deadlines.requestMs,
      );
      if (shot.type !== "shot") throw new AppFailure("internal", "Unexpected 3D reply.");
      return {
        instances: r.scene.header.counts.instances,
        chunks: r.scene.header.chunks.length,
        pngBytes: shot.png.length,
      };
    } finally {
      lane.drop(new AppFailure("cancelled", "The 3D self check is done."));
    }
  }

  /** Stops every worker (app shutdown). */
  dispose(): void {
    const closing = new AppFailure("cancelled", "Slabyrinth is closing.");
    for (const lane of Object.values(this.lanes)) lane.drop(closing);
  }
}
