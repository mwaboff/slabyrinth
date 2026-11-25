/**
 * The interactive 3D viewer engine: opens a scene from a SceneSource, keeps the camera, plans and draws frames only
 * when something changed (no idle loop), pulls the chunks a frame needs (nearest first) and the meshes near chunks
 * need under a GPU budget, swaps to the detailed scene when the source has read the game's shapes (keeping the
 * camera), picks, and exposes everything the tab's surface needs as an imperative API (View3dApi) plus events. GL
 * lives behind a RenderBackend, so the whole engine runs in tests with a recording fake.
 */
import type { PlacementRole } from "@slabyrinth/core/contracts/compiler";
import { BACKGROUND, COLOUR_CLASSES, type Box3, type ColourClass } from "@slabyrinth/scene3d";
import {
  SceneSourceError,
  type SceneHeader,
  type SceneProgress,
  type SceneSource,
  type SceneTarget,
  type WireBox,
} from "../sceneSource";
import { NO_CELL } from "../../../../shared/view3dWire";
import {
  meshGpuBytes,
  NO_SELECTION,
  type FrameSample,
  type FrameUniforms,
  type RenderBackend,
} from "./backend";
import {
  FOV_DEG,
  clampView,
  clipPlanes,
  copyView,
  eyeOf,
  flySpeed,
  flyView,
  frameView,
  limitsFor,
  newView,
  orbitView,
  panView,
  tweenAt,
  zoomViewAbout,
  type CameraLimits,
  type CameraView,
  type Tween,
} from "./camera";
import { ChunkCache } from "./chunkCache";
import { defaultFilters, filterMasks, type FilterMasks, type ViewFilters } from "./filters";
import { basisInto, distanceToBox, farthestToBox, frustumInto, viewProjInto } from "./math";
import { pickRay, rayPlaneY, rayThrough, type Ray } from "./pick";
import { DEFAULT_BUDGETS, DrawList, PlanScratch, planFrame, type PlanBudgets } from "./plan";
import { MeshResidency, MeshState } from "./residency";
import { ChunkState, SceneStore, type Chunk } from "./store";

/** What a pick found: the piece and what it belongs to. */
export interface PickInfo {
  /** The piece's scene-wide id (stable within one opened scene). */
  id: number;
  name: string;
  meshKey: string;
  colourClass: ColourClass;
  /** The class's plain name ("Wall", "Door, window, gate"). */
  classLabel: string;
  levelId: string;
  levelIndex: number;
  levelName: string;
  /** Paste layer: "site", "storey:<n>", "roof". */
  layer: string;
  /** The plan element it was built for, when the scene knows. */
  elementId: string | null;
  /** The placement's role ("floor", "wall", "opening", …); null for a piece with none (read from a slab). */
  role: string | null;
  /** The plan cell it was built for (x, y), when the scene knows. */
  cell: readonly [x: number, y: number] | null;
  /** Drawn as its game mesh now, or as a box. */
  stand: "mesh" | "box";
  /** Where the ray met the piece's box. */
  point: { x: number; y: number; z: number };
  box: Box3;
}

export type View3dError =
  | { code: "no-webgl2"; message: string }
  | { code: "init-failed"; message: string }
  | { code: "source"; sourceCode: SceneSourceError["code"]; message: string };

export type View3dState =
  | { kind: "idle" }
  | { kind: "loading"; progress: SceneProgress | null }
  | { kind: "ready" }
  /** The GPU context was lost; drawing resumes when the browser restores it. */
  | { kind: "lost" }
  | { kind: "error"; error: View3dError };

export interface ViewStats {
  frames: number;
  /** CPU time of the last frame (plan + draw submission), ms. */
  frameMs: number;
  /** From open() to the first frame that drew pieces, ms (null until then). */
  firstFrameMs: number | null;
  drawCalls: number;
  triangles: number;
  instancesDrawn: number;
  boxesDrawn: number;
  chunks: number;
  chunksVisible: number;
  chunksLoaded: number;
  /** Visible chunks at each level of detail: meshes, boxes, summary. */
  lodChunks: [number, number, number];
  instancesLoaded: number;
  instanceCount: number;
  meshesResident: number;
  /** Meshes that can have detail (stand-ins excluded). */
  meshesWithDetail: number;
  meshesInFlight: number;
  /** Estimated GPU bytes: meshes + chunk buffers + offscreen targets. */
  gpuBytes: number;
  gpuBudgetBytes: number;
  /** Bytes of the loaded pieces' data held by the viewer (JS heap). */
  sceneBytes: number;
  /** Detail was reduced to stay inside the budgets in the last frame. */
  limited: boolean;
}

export interface View3dEvents {
  state: View3dState;
  /** The source's layout and detail progress for the open scene. */
  progress: SceneProgress;
  /** A (new) header: the first scene, or the detailed scene that replaced the boxes one. */
  header: SceneHeader;
  /** Mesh detail: resident of those with detail, and requests in flight. */
  detail: { resident: number; total: number; inFlight: number };
  frame: ViewStats;
  camera: CameraView;
  hover: PickInfo | null;
  pick: PickInfo | null;
  /** Detail limited to keep the view responsive (true) or back to full (false). */
  limited: boolean;
}

/** The imperative API the tab's surface drives (buttons, menus, shortcuts). */
export interface View3dApi {
  readonly state: View3dState;
  readonly header: SceneHeader | null;
  frameAll(): void;
  frameLevel(levelIndex: number): void;
  /** Frames every loaded piece of a plan element; false when none is loaded. */
  frameElement(elementId: string): boolean;
  frameBox(box: Box3): void;
  /** Frames the selected piece; false when nothing is selected. */
  frameSelection(): boolean;
  topDown(): void;
  orbit(dBearing: number, dElevation: number): void;
  pan(dxPx: number, dyPx: number): void;
  /** Zoom by a factor (< 1 nearer), toward the point under the client position when given. */
  zoom(factor: number, clientX?: number, clientY?: number): void;
  getCamera(): CameraView;
  setCamera(view: CameraView, animate?: boolean): void;
  setLevelVisible(levelIndex: number, visible: boolean): void;
  setCutLevel(levelIndex: number | null): void;
  setRoofsHidden(hidden: boolean): void;
  setHiddenClasses(classes: readonly ColourClass[]): void;
  /** Hides pieces by their placement role (pieces with none stay). */
  setHiddenRoles(roles: readonly PlacementRole[]): void;
  setCutHeight(y: number | null): void;
  setFade(on: boolean): void;
  getFilters(): Readonly<ViewFilters>;
  /** Bit i: a loaded piece is of header class i (grows as chunks arrive; 0 before any). */
  classesSeen(): number;
  pickAt(clientX: number, clientY: number): PickInfo | null;
  select(id: number | null): void;
  readonly selection: PickInfo | null;
  stats(): ViewStats;
  /** Reads the last frame back (tests, diagnostics). */
  sample(): FrameSample;
  on<E extends keyof View3dEvents>(event: E, fn: (v: View3dEvents[E]) => void): () => void;
}

export interface EngineOptions {
  /** Total GPU budget (default 384 MB): meshes get 60%, chunk buffers 30%, the rest is for the targets. */
  gpuBudgetBytes?: number;
  budgets?: Partial<PlanBudgets>;
  /** Packing time per frame, ms (default 8). */
  packMsPerFrame?: number;
  /** Background, 0..255 (default scene3d's BACKGROUND, as the software pictures). */
  background?: readonly [number, number, number];
  reducedMotion?: () => boolean;
  now?: () => number;
  /** Schedules a frame (default requestAnimationFrame). */
  schedule?: (fn: (t: number) => void) => number;
  cancelSchedule?: (h: number) => void;
}

const MOVE_MS = 250;
/** Pieces smaller than this on screen are skipped. */
const MIN_PX = 0.6;
/** Chunk requests: ids per request and requests in flight. */
const CHUNKS_PER_REQUEST = 64;
const CHUNK_REQUESTS = 2;

type Listeners = { [E in keyof View3dEvents]: Set<(v: View3dEvents[E]) => void> };

export const box3 = (b: WireBox): Box3 => ({
  min: { x: b.min[0], y: b.min[1], z: b.min[2] },
  max: { x: b.max[0], y: b.max[1], z: b.max[2] },
});
const EMPTY_BOX: Box3 = {
  min: { x: Infinity, y: Infinity, z: Infinity },
  max: { x: -Infinity, y: -Infinity, z: -Infinity },
};

interface OpenScene {
  serial: number;
  source: SceneSource;
  target: SceneTarget;
  sceneId: string | null;
  offProgress: () => void;
  chunkRequests: number;
  /** A detailed scene is being opened to replace this one. */
  swapping: boolean;
}

export class View3dEngine implements View3dApi {
  private backend: RenderBackend | null;
  private readonly canvas: { clientWidth: number; clientHeight: number; getBoundingClientRect(): DOMRect };
  private readonly opts: Required<Omit<EngineOptions, "budgets">> & { budgets: PlanBudgets };
  private readonly listeners: Listeners = {
    state: new Set(),
    progress: new Set(),
    header: new Set(),
    detail: new Set(),
    frame: new Set(),
    camera: new Set(),
    hover: new Set(),
    pick: new Set(),
    limited: new Set(),
  };
  private _state: View3dState = { kind: "idle" };
  private scene: OpenScene | null = null;
  private serial = 0;
  private store: SceneStore | null = null;
  private residency: MeshResidency | null = null;
  private chunks: ChunkCache | null = null;
  private filters: ViewFilters = defaultFilters();
  private masks: FilterMasks | null = null;
  private filterVersion = 0;
  private openedAt = 0;
  private firstFrameMs: number | null = null;
  // camera
  private readonly view: CameraView = newView();
  private limits: CameraLimits = limitsFor(EMPTY_BOX);
  private tween: Tween | null = null;
  private framed = false;
  private readonly move = { forward: 0, right: 0, up: 0, fast: false, lastMs: -1 };
  // per-frame scratch (no allocation in the hot path)
  private readonly eye = { x: 0, y: 0, z: 0 };
  private readonly basis = new Float64Array(9);
  private readonly viewProj = new Float32Array(16);
  private readonly planes = new Float64Array(24);
  private readonly bounds6 = new Float32Array(6);
  private readonly list = new DrawList();
  private readonly planScratch = new PlanScratch();
  private readonly requests = new Int32Array(16);
  private readonly evicted = new Int32Array(256);
  private readonly ray: Ray = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1 };
  private readonly uniforms: FrameUniforms;
  private frame = 0;
  private scheduled: number | null = null;
  private width = 1;
  private height = 1;
  private readonly lastStats: ViewStats;
  private wasLimited = false;
  private _selection: PickInfo | null = null;
  private hoverId = -1;

  constructor(
    backend: RenderBackend | null,
    canvas: { clientWidth: number; clientHeight: number; getBoundingClientRect(): DOMRect },
    opts: EngineOptions = {},
  ) {
    this.backend = backend;
    this.canvas = canvas;
    const raf = typeof requestAnimationFrame === "function";
    this.opts = {
      gpuBudgetBytes: opts.gpuBudgetBytes ?? 384 * 1024 * 1024,
      budgets: { ...DEFAULT_BUDGETS, ...opts.budgets },
      packMsPerFrame: opts.packMsPerFrame ?? 8,
      background: opts.background ?? BACKGROUND,
      reducedMotion:
        opts.reducedMotion ??
        (() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches),
      now: opts.now ?? (() => performance.now()),
      schedule:
        opts.schedule ??
        (raf
          ? (fn) => requestAnimationFrame(fn)
          : (fn) =>
              setTimeout(() => {
                fn(performance.now());
              }, 16)),
      cancelSchedule:
        opts.cancelSchedule ??
        (raf
          ? (h) => {
              cancelAnimationFrame(h);
            }
          : (h) => {
              clearTimeout(h);
            }),
    };
    const bg = this.opts.background;
    this.uniforms = {
      viewProj: this.viewProj,
      eye: this.eye,
      target: this.view.target,
      pxK: 1,
      minPx: MIN_PX,
      masks: {
        classMask: 0,
        roleMask: 0,
        hideRoofs: false,
        levelShown: new Uint8Array(0),
        cutHeight: Infinity,
      },
      fade: false,
      fadeRadius: 4,
      selected: NO_SELECTION,
      background: [bg[0] / 255, bg[1] / 255, bg[2] / 255],
      grid: { show: false, y: 0, minX: 0, maxX: 1, minZ: 0, maxZ: 1 },
    };
    this.lastStats = {
      frames: 0,
      frameMs: 0,
      firstFrameMs: null,
      drawCalls: 0,
      triangles: 0,
      instancesDrawn: 0,
      boxesDrawn: 0,
      chunks: 0,
      chunksVisible: 0,
      chunksLoaded: 0,
      lodChunks: [0, 0, 0],
      instancesLoaded: 0,
      instanceCount: 0,
      meshesResident: 0,
      meshesWithDetail: 0,
      meshesInFlight: 0,
      gpuBytes: 0,
      gpuBudgetBytes: this.opts.gpuBudgetBytes,
      sceneBytes: 0,
      limited: false,
    };
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------

  get state(): View3dState {
    return this._state;
  }

  get header(): SceneHeader | null {
    return this.store?.header ?? null;
  }

  get selection(): PickInfo | null {
    return this._selection;
  }

  private setState(s: View3dState): void {
    this._state = s;
    this.emit("state", s);
  }

  /** The engine cannot draw at all (no WebGL2): it stays in this error state. */
  fail(error: View3dError): void {
    this.setState({ kind: "error", error });
  }

  private live(s: OpenScene): boolean {
    return this.scene === s && s.serial === this.serial;
  }

  /** Opens the scene of a plan version or build from a source (closing any open one). */
  open(source: SceneSource, target: SceneTarget): void {
    this.close();
    if (!this.backend) return;
    const s: OpenScene = {
      serial: ++this.serial,
      source,
      target,
      sceneId: null,
      offProgress: () => undefined,
      chunkRequests: 0,
      swapping: false,
    };
    this.scene = s;
    this.openedAt = this.opts.now();
    this.firstFrameMs = null;
    this.framed = false;
    this.setState({ kind: "loading", progress: null });
    s.offProgress = source.onProgress((p) => {
      if (!this.live(s)) return;
      // layout progress arrives before the header names the scene; detail progress names it
      if (s.sceneId !== null && p.sceneId !== s.sceneId) return;
      this.emit("progress", p);
      if (this._state.kind === "loading") this.setState({ kind: "loading", progress: p });
      if (
        p.stage === "detail" &&
        p.done >= p.total &&
        !s.swapping &&
        (this.store?.header.pendingDetail ?? 0) > 0
      )
        this.swapToDetail(s);
    });
    source.open(target).then(
      (h) => {
        if (!this.live(s)) {
          source.close(h.sceneId);
          return;
        }
        s.sceneId = h.sceneId;
        this.useHeader(h, true);
        this.setState({ kind: "ready" });
      },
      (e: unknown) => {
        if (!this.live(s)) return;
        this.sourceFailed(e);
      },
    );
  }

  private sourceFailed(e: unknown): void {
    const code = e instanceof SceneSourceError ? e.code : "failed";
    const message = e instanceof Error ? e.message : String(e);
    this.setState({ kind: "error", error: { code: "source", sourceCode: code, message } });
  }

  /** The source has read the game's shapes: open again and replace the boxes scene, keeping the camera. */
  private swapToDetail(s: OpenScene): void {
    s.swapping = true;
    s.source.open(s.target).then(
      (h) => {
        if (!this.live(s)) {
          s.source.close(h.sceneId);
          return;
        }
        const old = s.sceneId;
        s.sceneId = h.sceneId;
        s.swapping = false;
        this.freeScene();
        if (old !== null && old !== h.sceneId) s.source.close(old);
        this.useHeader(h, false);
      },
      () => {
        // the boxes scene stays; nothing is lost
        if (this.live(s)) s.swapping = false;
      },
    );
  }

  private useHeader(h: SceneHeader, frame: boolean): void {
    const store = new SceneStore(h);
    this.store = store;
    const total = this.opts.gpuBudgetBytes;
    this.residency = new MeshResidency(
      h.meshes.map((m) => m.box),
      { budgetBytes: Math.floor(total * 0.6) },
    );
    if (this.backend)
      this.chunks = new ChunkCache(store, this.backend, Math.floor(total * 0.3), this.opts.now);
    this.masks = filterMasks(store, this.filters);
    this.filterVersion++;
    const bounds = h.bounds ? box3(h.bounds) : EMPTY_BOX;
    this.limits = limitsFor(bounds);
    const ok = h.bounds !== null;
    const pad = ok
      ? Math.max(16, Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 0.1)
      : 0;
    this.uniforms.grid = {
      show: ok,
      y: ok ? bounds.min.y - 0.01 : 0,
      minX: ok ? Math.floor(bounds.min.x - pad) : 0,
      maxX: ok ? Math.ceil(bounds.max.x + pad) : 1,
      minZ: ok ? Math.floor(bounds.min.z - pad) : 0,
      maxZ: ok ? Math.ceil(bounds.max.z + pad) : 1,
    };
    if (frame) {
      this.frameAllNow(false);
      this.framed = true;
    } else clampView(this.view, this.limits);
    // a swapped scene keeps the selection only by position: clear it (ids belong to the old scene)
    this._selection = null;
    this.hoverId = -1;
    this.emit("header", h);
    this.requestRender();
  }

  /** Frees the current scene's GPU buffers and data (not the source's scene). */
  private freeScene(): void {
    const backend = this.backend;
    const live = backend && !backend.isLost();
    if (live && this.residency)
      for (let m = 0; m < this.residency.count; m++)
        if (this.residency.state[m] === MeshState.Resident) backend.deleteMesh(m);
    if (live) this.chunks?.dispose();
    this.chunks = null;
    this.residency = null;
    this.store = null;
  }

  /** Closes the open scene: frees GPU buffers and releases the source's scene. */
  close(): void {
    const s = this.scene;
    this.serial++;
    this.scene = null;
    if (s) {
      s.offProgress();
      if (s.sceneId !== null) s.source.close(s.sceneId);
      else s.source.cancel();
    }
    this.freeScene();
    this._selection = null;
    this.hoverId = -1;
    this.tween = null;
    if (this._state.kind !== "error" || this.backend) this._state = { kind: "idle" };
  }

  dispose(): void {
    this.close();
    if (this.scheduled !== null) this.opts.cancelSchedule(this.scheduled);
    this.scheduled = null;
    this.backend?.dispose();
    this.backend = null;
    for (const k of Object.keys(this.listeners) as (keyof View3dEvents)[]) this.listeners[k].clear();
  }

  /** Drawing-buffer size changed (device pixels). */
  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.backend?.resize(this.width, this.height);
    if (this.store && !this.framed) {
      this.frameAllNow(false);
      this.framed = true;
    }
    this.requestRender();
  }

  /** The GPU context was lost: every GPU object is gone. */
  contextLost(): void {
    this.residency?.reset();
    this.chunks?.forget();
    this.setState({ kind: "lost" });
  }

  /** The context is back: draw again (meshes are asked for again as chunks need them). */
  contextRestored(): void {
    this.backend?.resize(this.width, this.height);
    this.setState(this.store ? { kind: "ready" } : { kind: "idle" });
    this.requestRender();
  }

  // ---- events ----------------------------------------------------------------------------------------------------

  on<E extends keyof View3dEvents>(event: E, fn: (v: View3dEvents[E]) => void): () => void {
    const set = this.listeners[event] as Set<(v: View3dEvents[E]) => void>;
    set.add(fn);
    return () => set.delete(fn);
  }

  private emit<E extends keyof View3dEvents>(event: E, v: View3dEvents[E]): void {
    for (const fn of this.listeners[event] as Set<(v: View3dEvents[E]) => void>) fn(v);
  }

  // ---- drawing ---------------------------------------------------------------------------------------------------

  /** Asks for one frame (several asks before it is drawn make one frame). */
  requestRender(): void {
    if (this.scheduled !== null || !this.backend) return;
    this.scheduled = this.opts.schedule((t) => {
      this.scheduled = null;
      this.renderFrame(t);
    });
  }

  /** Draws a frame now. */
  renderFrame(nowMs: number = this.opts.now()): void {
    const backend = this.backend;
    const store = this.store;
    const residency = this.residency;
    const chunks = this.chunks;
    if (!backend || backend.isLost()) return;
    const t0 = this.opts.now();
    let again = false;
    if (this.tween) {
      if (tweenAt(this.tween, nowMs, this.view)) this.tween = null;
      else again = true;
      clampView(this.view, this.limits);
      this.emit("camera", this.view);
    }
    if (this.move.forward !== 0 || this.move.right !== 0 || this.move.up !== 0) {
      const dt = this.move.lastMs < 0 ? 1 / 60 : Math.min(0.1, (nowMs - this.move.lastMs) / 1000);
      this.move.lastMs = nowMs;
      const v = flySpeed(this.view, this.move.fast) * dt;
      flyView(this.view, this.move.forward * v, this.move.right * v, this.move.up * v);
      clampView(this.view, this.limits);
      this.emit("camera", this.view);
      again = true;
    }
    this.frame++;
    const aspect = this.width / this.height;
    eyeOf(this.view, this.eye);
    const tg = this.view.target;
    basisInto(this.basis, this.eye.x, this.eye.y, this.eye.z, tg.x, tg.y, tg.z);
    let near = 0.05;
    let far = 1000;
    const g = this.uniforms.grid;
    const hb = store?.header.bounds;
    if (hb) {
      const bb = this.bounds6;
      bb[0] = Math.min(hb.min[0], g.minX);
      bb[1] = hb.min[1] - 0.02;
      bb[2] = Math.min(hb.min[2], g.minZ);
      bb[3] = Math.max(hb.max[0], g.maxX);
      bb[4] = hb.max[1];
      bb[5] = Math.max(hb.max[2], g.maxZ);
      const planes = clipPlanes(
        distanceToBox(bb, 0, this.eye.x, this.eye.y, this.eye.z),
        farthestToBox(bb, 0, this.eye.x, this.eye.y, this.eye.z),
        this.view.distance,
      );
      near = planes.near;
      far = planes.far;
    }
    viewProjInto(this.viewProj, this.basis, this.eye.x, this.eye.y, this.eye.z, FOV_DEG, aspect, near, far);
    frustumInto(this.planes, this.viewProj);
    const pxK = this.height / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
    const list = this.list;
    if (store && residency && chunks && this.masks) {
      chunks.beginFrame(this.frame, t0 + this.opts.packMsPerFrame, this.masks, this.filterVersion);
      planFrame(
        {
          store,
          residency,
          masks: this.masks,
          frame: this.frame,
          eye: this.eye,
          planes: this.planes,
          pxK,
          budgets: this.opts.budgets,
          buffers: chunks,
        },
        list,
        this.planScratch,
      );
      if (list.incomplete) again = true;
    } else list.reset();
    const u = this.uniforms;
    u.pxK = pxK;
    u.target = tg;
    u.fade = this.filters.fade;
    u.fadeRadius = Math.max(2, this.view.distance * 0.18);
    if (this.masks) u.masks = this.masks;
    u.selected = this._selection ? this._selection.id : NO_SELECTION;
    backend.draw(u, list);
    if (store && list.missing > 0) this.fetchChunks(store);
    if (residency && this.scene?.sceneId) {
      residency.retryOverBudget();
      const n = residency.takeRequests(this.requests);
      if (n > 0) this.fetchMeshes(this.requests, n);
    }
    const ms = this.opts.now() - t0;
    if (this.firstFrameMs === null && list.instances > 0) this.firstFrameMs = this.opts.now() - this.openedAt;
    this.collectStats(ms);
    this.emit("frame", this.lastStats);
    const limited = list.limited || (residency?.limited ?? false);
    if (residency) residency.limited = false;
    if (limited !== this.wasLimited) {
      this.wasLimited = limited;
      this.emit("limited", limited);
    }
    if (again) this.requestRender();
  }

  /** Asks the source for the chunks this frame wanted and lacked, nearest first. */
  private fetchChunks(store: SceneStore): void {
    const s = this.scene;
    if (!s?.sceneId || s.chunkRequests >= CHUNK_REQUESTS) return;
    const wanted: Chunk[] = [];
    for (const c of store.chunks)
      if (c.state === ChunkState.Absent && c.wantFrame === this.frame) wanted.push(c);
    wanted.sort((a, b) => a.wantDist - b.wantDist);
    while (wanted.length > 0 && s.chunkRequests < CHUNK_REQUESTS) {
      const batch = wanted.splice(0, CHUNKS_PER_REQUEST);
      for (const c of batch) c.state = ChunkState.Requested;
      s.chunkRequests++;
      const sceneId = s.sceneId;
      s.source
        .chunks(
          sceneId,
          batch.map((c) => c.id),
        )
        .then(
          (r) => {
            if (!this.live(s) || this.store !== store) return;
            s.chunkRequests--;
            for (const data of r.chunks) store.load(data);
            // what did not fit the reply is asked for again when a frame still wants it
            for (const c of batch) if (c.state === ChunkState.Requested) c.state = ChunkState.Absent;
            this.requestRender();
          },
          (e: unknown) => {
            if (!this.live(s) || this.store !== store) return;
            s.chunkRequests--;
            for (const c of batch) if (c.state === ChunkState.Requested) c.state = ChunkState.Absent;
            if (!(e instanceof SceneSourceError && e.code === "cancelled")) this.sourceFailed(e);
          },
        );
    }
  }

  /** Asks the source for meshes (one request for the batch); answers are admitted under the budget. */
  private fetchMeshes(list: Int32Array, n: number): void {
    const s = this.scene;
    const store = this.store;
    const residency = this.residency;
    if (!s?.sceneId || !store || !residency) return;
    const byKey = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const m = list[i] ?? 0;
      const key = store.header.meshes[m]?.key;
      if (key !== undefined) byKey.set(key, m);
    }
    s.source.meshes(s.sceneId, [...byKey.keys()]).then(
      (r) => {
        if (!this.live(s) || this.residency !== residency) return;
        const backend = this.backend;
        for (const geom of r.meshes) {
          const m = byKey.get(geom.key);
          if (m === undefined) continue;
          byKey.delete(geom.key);
          if (!backend || backend.isLost()) {
            residency.failed(m, true);
            continue;
          }
          const a = residency.admit(m, meshGpuBytes(geom), this.frame, this.evicted);
          for (let i = 0; i < a.evictedCount; i++) backend.deleteMesh(this.evicted[i] ?? 0);
          if (a.ok) backend.uploadMesh(m, geom);
        }
        // keys in `more` may be asked again; keys the source did not answer stay boxes
        const more = new Set(r.more);
        for (const [key, m] of byKey) residency.failed(m, more.has(key));
        this.emitDetail();
        this.requestRender();
      },
      (e: unknown) => {
        if (!this.live(s) || this.residency !== residency) return;
        const retry = e instanceof SceneSourceError && e.code === "cancelled";
        for (const m of byKey.values()) residency.failed(m, retry);
        this.emitDetail();
        this.requestRender();
      },
    );
  }

  private emitDetail(): void {
    const r = this.residency;
    if (!r) return;
    this.emit("detail", { resident: r.residentCount(), total: r.detailCount(), inFlight: r.inFlight });
  }

  private collectStats(frameMs: number): void {
    const l = this.list;
    const r = this.residency;
    const s = this.lastStats;
    // one stats object, reused: listeners copy what they keep
    s.frames = this.frame;
    s.frameMs = frameMs;
    s.firstFrameMs = this.firstFrameMs;
    s.drawCalls = l.n;
    s.triangles = l.triangles;
    s.instancesDrawn = l.instances;
    s.boxesDrawn = l.boxes;
    s.chunks = this.store?.chunks.length ?? 0;
    s.chunksVisible = l.chunksVisible;
    s.chunksLoaded = this.store?.loadedChunks ?? 0;
    s.lodChunks[0] = l.lodChunks[0] ?? 0;
    s.lodChunks[1] = l.lodChunks[1] ?? 0;
    s.lodChunks[2] = l.lodChunks[2] ?? 0;
    s.instancesLoaded = this.store?.loadedInstances ?? 0;
    s.instanceCount = this.store?.n ?? 0;
    s.meshesResident = r ? r.residentCount() : 0;
    s.meshesWithDetail = r ? r.detailCount() : 0;
    s.meshesInFlight = r ? r.inFlight : 0;
    s.gpuBytes = (r?.usedBytes ?? 0) + (this.chunks?.bytes ?? 0) + (this.backend?.framebufferBytes() ?? 0);
    s.limited = l.limited || (r?.limited ?? false);
    s.sceneBytes = this.store?.loadedBytes ?? 0;
  }

  stats(): ViewStats {
    return { ...this.lastStats, lodChunks: [...this.lastStats.lodChunks] };
  }

  sample(): FrameSample {
    return this.backend ? this.backend.sample() : { width: 0, height: 0, drawnPixels: 0, distinctIds: 0 };
  }

  // ---- camera ----------------------------------------------------------------------------------------------------

  private changed(): void {
    clampView(this.view, this.limits);
    this.emit("camera", this.view);
    this.requestRender();
  }

  private moveTo(to: CameraView, animate: boolean): void {
    clampView(to, this.limits);
    if (!animate || this.opts.reducedMotion()) {
      this.tween = null;
      copyView(to, this.view);
      this.changed();
      return;
    }
    this.tween = { from: copyView(this.view, newView()), to, startMs: this.opts.now(), durationMs: MOVE_MS };
    this.requestRender();
  }

  private frameAllNow(animate: boolean): void {
    const b = this.store?.header.bounds;
    if (!b) return;
    this.moveTo(frameView(box3(b), 225, 35, this.width / this.height, newView()), animate);
  }

  frameAll(): void {
    this.frameAllNow(true);
  }

  frameBox(box: Box3): void {
    const elevation = Math.max(this.view.elevation, 30);
    this.moveTo(frameView(box, this.view.bearing, elevation, this.width / this.height, newView()), true);
  }

  frameLevel(levelIndex: number): void {
    const b = this.store?.header.levels[levelIndex]?.bounds;
    if (!b) return;
    this.moveTo(frameView(box3(b), this.view.bearing, 55, this.width / this.height, newView()), true);
  }

  frameElement(elementId: string): boolean {
    const b = this.bounds6;
    if (!this.store?.elementBox(elementId, b)) return false;
    this.frameBox({
      min: { x: b[0] ?? 0, y: b[1] ?? 0, z: b[2] ?? 0 },
      max: { x: b[3] ?? 0, y: b[4] ?? 0, z: b[5] ?? 0 },
    });
    return true;
  }

  frameSelection(): boolean {
    const s = this._selection;
    if (!s) return false;
    const grow = 2;
    this.frameBox({
      min: { x: s.box.min.x - grow, y: s.box.min.y, z: s.box.min.z - grow },
      max: { x: s.box.max.x + grow, y: s.box.max.y + 1, z: s.box.max.z + grow },
    });
    return true;
  }

  /** Straight down, north up, framed on the map. */
  topDown(): void {
    const b = this.store?.header.bounds;
    const to = b
      ? frameView(box3(b), 180, 89.5, this.width / this.height, newView())
      : copyView(this.view, newView());
    to.elevation = 89.5;
    this.moveTo(to, true);
  }

  orbit(dBearing: number, dElevation: number): void {
    this.tween = null;
    orbitView(this.view, dBearing, dElevation);
    this.changed();
  }

  pan(dxPx: number, dyPx: number): void {
    this.tween = null;
    panView(this.view, dxPx, dyPx, this.canvas.clientHeight || this.height);
    this.changed();
  }

  zoom(factor: number, clientX?: number, clientY?: number): void {
    this.tween = null;
    let p: { x: number; y: number; z: number } | null = null;
    if (clientX !== undefined && clientY !== undefined && this.store && this.masks) {
      const r = this.rayAt(clientX, clientY);
      const hit = pickRay(this.store, this.masks, r);
      if (hit) p = { x: r.ox + r.dx * hit.t, y: r.oy + r.dy * hit.t, z: r.oz + r.dz * hit.t };
      else {
        const q = { x: 0, y: 0, z: 0 };
        if (rayPlaneY(r, this.limits.ground, q)) p = q;
      }
    }
    zoomViewAbout(this.view, p, factor, this.limits);
    this.changed();
  }

  /** Held-key flying: directions in -1..1 (forward, right, up); frames are drawn while any is held. */
  setMove(forward: number, right: number, up: number, fast: boolean): void {
    const was = this.move.forward !== 0 || this.move.right !== 0 || this.move.up !== 0;
    this.move.forward = forward;
    this.move.right = right;
    this.move.up = up;
    this.move.fast = fast;
    const now = forward !== 0 || right !== 0 || up !== 0;
    if (now) this.tween = null;
    if (now && !was) {
      this.move.lastMs = -1;
      this.requestRender();
    }
  }

  getCamera(): CameraView {
    return copyView(this.view, newView());
  }

  setCamera(view: CameraView, animate = false): void {
    this.moveTo(copyView(view, newView()), animate);
  }

  /** The current camera limits. */
  getLimits(): CameraLimits {
    return this.limits;
  }

  // ---- seeing inside ---------------------------------------------------------------------------------------------

  private filtersChanged(next: ViewFilters): void {
    this.filters = next;
    if (this.store) this.masks = filterMasks(this.store, this.filters, this.masks ?? undefined);
    this.filterVersion++;
    this.requestRender();
  }

  setLevelVisible(levelIndex: number, visible: boolean): void {
    const s = new Set(this.filters.hiddenLevels);
    if (visible) s.delete(levelIndex);
    else s.add(levelIndex);
    this.filtersChanged({ ...this.filters, hiddenLevels: s });
  }

  setCutLevel(levelIndex: number | null): void {
    this.filtersChanged({ ...this.filters, cutLevel: levelIndex });
  }

  setRoofsHidden(hidden: boolean): void {
    this.filtersChanged({ ...this.filters, hideRoofs: hidden });
  }

  setHiddenClasses(classes: readonly ColourClass[]): void {
    this.filtersChanged({ ...this.filters, hiddenClasses: new Set(classes) });
  }

  setHiddenRoles(roles: readonly PlacementRole[]): void {
    this.filtersChanged({ ...this.filters, hiddenRoles: new Set(roles) });
  }

  setCutHeight(y: number | null): void {
    this.filtersChanged({ ...this.filters, cutHeight: y });
  }

  setFade(on: boolean): void {
    this.filters = { ...this.filters, fade: on };
    this.requestRender();
  }

  getFilters(): Readonly<ViewFilters> {
    return this.filters;
  }

  classesSeen(): number {
    return this.store?.classesSeen ?? 0;
  }

  // ---- picking ---------------------------------------------------------------------------------------------------

  private rayAt(clientX: number, clientY: number): Ray {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || this.width;
    const h = rect.height || this.height;
    const nx = ((clientX - rect.left) / w) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / h) * 2;
    eyeOf(this.view, this.eye);
    const tg = this.view.target;
    basisInto(this.basis, this.eye.x, this.eye.y, this.eye.z, tg.x, tg.y, tg.z);
    return rayThrough(this.basis, this.eye, w / h, nx, ny, this.ray);
  }

  pickAt(clientX: number, clientY: number): PickInfo | null {
    const store = this.store;
    if (!store || !this.masks) return null;
    const r = this.rayAt(clientX, clientY);
    const hit = pickRay(store, this.masks, r);
    if (!hit) return null;
    return this.info(hit.id, { x: r.ox + r.dx * hit.t, y: r.oy + r.dy * hit.t, z: r.oz + r.dz * hit.t });
  }

  /** What the piece with this scene-wide id is (null when its chunk is not loaded). */
  info(id: number, point?: { x: number; y: number; z: number }): PickInfo | null {
    const s = this.store;
    const c = s?.chunkOf(id);
    const d = c?.data;
    if (!s || !c || !d || !c.aabb) return null;
    const k = id - c.base;
    const h = s.header;
    const meshIndex = d.mesh[k] ?? 0;
    const mesh = h.meshes[meshIndex];
    const clsId = (h.classes[d.colourClass[k] ?? 0]?.id ?? "unknown") as ColourClass;
    const cls: ColourClass = clsId in COLOUR_CLASSES ? clsId : "unknown";
    const levelIndex = d.level[k] ?? 0;
    const lv = h.levels[levelIndex];
    const el = d.element[k] ?? -1;
    const ri = d.role[k] ?? -1;
    const cx = d.cell[k * 2] ?? NO_CELL;
    const cy = d.cell[k * 2 + 1] ?? NO_CELL;
    const a = k * 6;
    const A = c.aabb;
    const box: Box3 = {
      min: { x: A[a] ?? 0, y: A[a + 1] ?? 0, z: A[a + 2] ?? 0 },
      max: { x: A[a + 3] ?? 0, y: A[a + 4] ?? 0, z: A[a + 5] ?? 0 },
    };
    return {
      id,
      name: d.names[d.name[k] ?? 0] ?? "",
      meshKey: mesh?.key ?? "",
      colourClass: cls,
      classLabel: h.classes[d.colourClass[k] ?? 0]?.label ?? COLOUR_CLASSES[cls].label,
      levelId: lv?.id ?? "",
      levelIndex,
      levelName: lv?.name ?? "",
      layer: d.layers[d.layer[k] ?? 0] ?? "site",
      elementId: el < 0 ? null : (d.elements[el] ?? null),
      role: ri < 0 ? null : (d.roles[ri] ?? null),
      cell: cx === NO_CELL && cy === NO_CELL ? null : [cx, cy],
      stand: this.residency?.state[meshIndex] === MeshState.Resident ? "mesh" : "box",
      point: point ?? {
        x: (box.min.x + box.max.x) / 2,
        y: (box.min.y + box.max.y) / 2,
        z: (box.min.z + box.max.z) / 2,
      },
      box,
    };
  }

  select(id: number | null): void {
    this._selection = id === null ? null : this.info(id);
    this.requestRender();
  }

  /** A click at a client position: selects what is there (or clears) and reports it. */
  clickAt(clientX: number, clientY: number): PickInfo | null {
    const p = this.pickAt(clientX, clientY);
    this._selection = p;
    this.requestRender();
    this.emit("pick", p);
    return p;
  }

  /** The pointer is over a client position: reports a change of the piece under it. */
  hoverAt(clientX: number, clientY: number): void {
    const p = this.pickAt(clientX, clientY);
    const id = p ? p.id : -1;
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.emit("hover", p);
  }

  /** The pointer left the canvas. */
  hoverOut(): void {
    if (this.hoverId === -1) return;
    this.hoverId = -1;
    this.emit("hover", null);
  }
}

/** The colour of a class as CSS (for the surface's key), from scene3d's single table. */
export function classColourCss(cls: ColourClass): string {
  const [r, g, b] = COLOUR_CLASSES[cls].rgb;
  return `rgb(${r}, ${g}, ${b})`;
}
