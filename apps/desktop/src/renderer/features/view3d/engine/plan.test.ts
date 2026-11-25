import { beforeAll, describe, expect, it } from "vitest";
import type { Scene } from "@slabyrinth/scene3d";
import { packScene } from "../memorySceneSource";
import { syntheticTown } from "../synthetic";
import { FOV_DEG, eyeOf } from "./camera";
import { ChunkCache } from "./chunkCache";
import { fakeBackend } from "./fakeBackend";
import { defaultFilters, filterMasks, type ViewFilters } from "./filters";
import { basisInto, frustumInto, viewProjInto } from "./math";
import { pickRay, rayThrough } from "./pick";
import {
  DEFAULT_BUDGETS,
  DRAW_MESH,
  DRAW_SUMMARY,
  DrawList,
  PlanScratch,
  chooseLod,
  planFrame,
  type PlanBudgets,
} from "./plan";
import { MeshResidency } from "./residency";
import { ChunkState, SceneStore } from "./store";

let scene: Scene;
beforeAll(async () => {
  scene = await syntheticTown({ side: 128 });
});

function setup(load = true): { store: SceneStore; residency: MeshResidency; cache: ChunkCache } {
  const { header, chunks } = packScene(scene, "s", "b");
  const store = new SceneStore(header);
  if (load) for (const c of chunks.values()) store.load(c);
  const residency = new MeshResidency(
    header.meshes.map((m) => m.box),
    { budgetBytes: 1e9 },
  );
  const cache = new ChunkCache(store, fakeBackend(), 1e9, () => 0);
  return { store, residency, cache };
}

interface Cam {
  view: { target: { x: number; y: number; z: number }; distance: number; bearing: number; elevation: number };
  height: number;
  aspect: number;
}

function plan(
  s: ReturnType<typeof setup>,
  cam: Cam,
  frame = 1,
  budgets: Partial<PlanBudgets> = {},
  filters: ViewFilters = defaultFilters(),
): DrawList {
  const eye = eyeOf(cam.view, { x: 0, y: 0, z: 0 });
  const b = new Float64Array(9);
  const t = cam.view.target;
  basisInto(b, eye.x, eye.y, eye.z, t.x, t.y, t.z);
  const m = new Float32Array(16);
  viewProjInto(m, b, eye.x, eye.y, eye.z, FOV_DEG, cam.aspect, 0.05, 5000);
  const planes = new Float64Array(24);
  frustumInto(planes, m);
  const masks = filterMasks(s.store, filters);
  s.cache.beginFrame(frame, Infinity, masks, 1);
  const list = new DrawList();
  planFrame(
    {
      store: s.store,
      residency: s.residency,
      masks,
      frame,
      eye,
      planes,
      pxK: cam.height / (2 * Math.tan((FOV_DEG * Math.PI) / 360)),
      budgets: { ...DEFAULT_BUDGETS, ...budgets },
      buffers: s.cache,
    },
    list,
    new PlanScratch(),
  );
  return list;
}

const overview: Cam = {
  view: { target: { x: 64, y: 0, z: 64 }, distance: 220, bearing: 225, elevation: 35 },
  height: 900,
  aspect: 16 / 9,
};

describe("frame planner", () => {
  it("chooses detail by the pixels a tile covers", () => {
    const pxK = 900 / (2 * Math.tan((45 * Math.PI) / 360));
    expect(chooseLod(10, pxK, DEFAULT_BUDGETS)).toBe(0);
    expect(chooseLod(300, pxK, DEFAULT_BUDGETS)).toBe(1);
    expect(chooseLod(2000, pxK, DEFAULT_BUDGETS)).toBe(2);
  });

  it("draws every chunk in view, one draw per mesh per chunk", () => {
    const s = setup();
    const near: Cam = { ...overview, view: { ...overview.view, distance: 60 } };
    const list = plan(s, near);
    expect(list.chunksVisible).toBeGreaterThan(0);
    expect(list.lodChunks[0]).toBeGreaterThan(0);
    // no chunk draws the same mesh twice
    const seen = new Set<string>();
    for (let i = 0; i < list.n; i++) {
      if (list.kind[i] !== DRAW_MESH) continue;
      const key = `${list.buffer[i]}:${list.mesh[i]}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("culls what is behind the camera", () => {
    const s = setup();
    const all = plan(s, overview).chunksVisible;
    const corner: Cam = {
      view: { target: { x: 4, y: 0, z: 4 }, distance: 6, bearing: 45, elevation: 20 },
      height: 900,
      aspect: 1.5,
    };
    expect(plan(s, corner).chunksVisible).toBeLessThan(all);
  });

  it("drops a level of detail instead of passing the triangle budget", () => {
    const s = setup();
    const near: Cam = { ...overview, view: { ...overview.view, distance: 40 } };
    const free = plan(s, near);
    const tight = plan(s, near, 1, { maxTriangles: Math.floor(free.triangles / 4) });
    expect(tight.limited).toBe(true);
    // the far summaries are always drawn (a chunk never vanishes); meshes and boxes keep to the budget
    let summary = 0;
    for (let i = 0; i < tight.n; i++)
      if (tight.kind[i] === DRAW_SUMMARY) summary += (tight.count[i] ?? 0) * 12;
    expect(tight.triangles - summary).toBeLessThanOrEqual(Math.floor(free.triangles / 4));
    expect(tight.lodChunks[0]).toBeLessThan(free.lodChunks[0] ?? 0);
  });

  it("draws far chunks as their summary boxes (fewer than their pieces)", () => {
    const s = setup();
    const far: Cam = { ...overview, view: { ...overview.view, distance: 4000 } };
    const list = plan(s, far);
    expect(list.lodChunks[2]).toBeGreaterThan(0);
    let boxes = 0;
    for (let i = 0; i < list.n; i++) if (list.kind[i] === DRAW_SUMMARY) boxes += list.count[i] ?? 0;
    expect(boxes).toBeGreaterThan(0);
    expect(boxes).toBeLessThan(s.store.n / 4);
  });

  it("asks for chunks it lacks instead of drawing them", () => {
    const s = setup(false);
    const list = plan(s, overview, 7);
    expect(list.n).toBe(0);
    expect(list.missing).toBeGreaterThan(0);
    const wanted = s.store.chunks.filter((c) => c.wantFrame === 7);
    expect(wanted.length).toBe(list.missing);
    expect(wanted.every((c) => c.state === ChunkState.Absent)).toBe(true);
  });

  it("hides levels above the cut and roofs, and picking agrees", () => {
    const s = setup();
    // above a building of at least two storeys
    const tall = scene.instances.find((i) => i.levelIndex === 1 && i.role === "floor");
    expect(tall).toBeDefined();
    const tx = tall ? tall.at.x + 0.5 : 0;
    const tz = tall ? tall.at.z + 0.5 : 0;
    const top: Cam = {
      view: { target: { x: tx, y: 0, z: tz }, distance: 150, bearing: 180, elevation: 89.5 },
      height: 600,
      aspect: 1,
    };
    const cut = { ...defaultFilters(), cutLevel: 0, hideRoofs: true };
    const masks = filterMasks(s.store, cut);
    const all = plan(s, top);
    const ground = plan(s, top, 2, {}, cut);
    expect(ground.chunksVisible).toBeLessThan(all.chunksVisible);
    // straight down onto the centre of each building: with roofs and upper levels hidden, a ground-level piece
    const eye = eyeOf(top.view, { x: 0, y: 0, z: 0 });
    const b = new Float64Array(9);
    basisInto(b, eye.x, eye.y, eye.z, tx, 0, tz);
    const ray = rayThrough(b, eye, 1, 0, 0, { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0 });
    const hitAll = pickRay(s.store, filterMasks(s.store, defaultFilters()), ray);
    const hitCut = pickRay(s.store, masks, ray);
    expect(hitAll).not.toBeNull();
    expect(hitCut).not.toBeNull();
    if (!hitCut || !hitAll) return;
    expect(hitCut.t).toBeGreaterThan(hitAll.t);
    const levelOf = (id: number): number | undefined => {
      const c = s.store.chunkOf(id);
      return c?.data?.level[id - c.base];
    };
    expect(levelOf(hitAll.id)).toBeGreaterThan(0);
    expect(levelOf(hitCut.id)).toBe(0);
    // a cut height below the upper storeys does the same without hiding a level
    const byHeight = pickRay(s.store, filterMasks(s.store, { ...defaultFilters(), cutHeight: 2.5 }), ray);
    expect(byHeight && levelOf(byHeight.id)).toBe(0);
  });
});
