/**
 * The scene checks on synthetic scenes of known shape (a gap of known width, a floating crate, a backwards gun): each
 * check has a scene it must flag and one it must pass. No game meshes, no install.
 */
import type { PlacementRole } from "@slabyrinth/core";
import { describe, expect, it } from "vitest";
import {
  SceneSpace,
  clusterFindings,
  clusterShot,
  compareFindings,
  cuboid,
  markedPicture,
  runChecks,
  type Box3,
  type CheckCode,
  type ColourClass,
  type MeshData,
  type PlanCell,
  type PlanFacts,
  type Scene,
  type SceneInstance,
} from "../src/index";

interface Spec {
  name?: string;
  min: [number, number, number];
  max: [number, number, number];
  role?: PlacementRole | null;
  cls?: ColourClass;
  element?: string | null;
  rot?: number;
  level?: number;
  layer?: string;
}

/** A scene of cuboid pieces (each its own mesh, placed at the origin unturned unless `rot` is given). */
function sceneOf(specs: readonly Spec[]): Scene {
  const meshes = new Map<string, MeshData>();
  const instances: SceneInstance[] = specs.map((s, i) => {
    const key = `m${String(i)}`;
    // a turned piece keeps its box centred on its own origin, so its world box is the turned local box
    const c = [(s.min[0] + s.max[0]) / 2, 0, (s.min[2] + s.max[2]) / 2] as const;
    const rot = s.rot ?? 0;
    meshes.set(
      key,
      cuboid(
        { x: s.min[0] - c[0], y: s.min[1], z: s.min[2] - c[2] },
        { x: s.max[0] - c[0], y: s.max[1], z: s.max[2] - c[2] },
      ),
    );
    const hx = (s.max[0] - s.min[0]) / 2;
    const hz = (s.max[2] - s.min[2]) / 2;
    const q = Math.round(rot / 90) % 2 === 1;
    const aabb: Box3 = {
      min: { x: c[0] - (q ? hz : hx), y: s.min[1], z: c[2] - (q ? hx : hz) },
      max: { x: c[0] + (q ? hz : hx), y: s.max[1], z: c[2] + (q ? hx : hz) },
    };
    return {
      uuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: s.name ?? "block",
      meshKey: key,
      rotDeg: rot,
      at: { x: c[0], y: 0, z: c[2] },
      aabb,
      colourClass: s.cls ?? "prop",
      colour: [128, 128, 128],
      levelId: `L${String(s.level ?? 0)}`,
      levelIndex: s.level ?? 0,
      layer: s.layer ?? "site",
      role: s.role === undefined ? "feature" : s.role,
      elementId: s.element === undefined ? `e${String(i)}` : s.element,
      cell: [Math.floor(c[0]), Math.floor(c[2])],
      stand: "mesh",
    };
  });
  const bounds: Box3 = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  for (const i of instances) {
    bounds.min.x = Math.min(bounds.min.x, i.aabb.min.x);
    bounds.min.y = Math.min(bounds.min.y, i.aabb.min.y);
    bounds.min.z = Math.min(bounds.min.z, i.aabb.min.z);
    bounds.max.x = Math.max(bounds.max.x, i.aabb.max.x);
    bounds.max.y = Math.max(bounds.max.y, i.aabb.max.y);
    bounds.max.z = Math.max(bounds.max.z, i.aabb.max.z);
  }
  return {
    origin: "build",
    instances,
    meshes,
    levels: [{ id: "L0", name: "Ground", index: 0, bounds }],
    bounds,
    fallbacks: [],
    meshSource: "test",
  };
}

/** A floor of 1 × 1 tiles (0.5 thick, top at 0.5) over x0..x1, z0..z1. */
const floor = (x0: number, x1: number, z0: number, z1: number): Spec[] => {
  const out: Spec[] = [];
  for (let x = x0; x < x1; x++)
    for (let z = z0; z < z1; z++)
      out.push({
        name: "floor",
        min: [x, 0, z],
        max: [x + 1, 0.5, z + 1],
        role: "floor",
        cls: "floor",
        element: "floor",
      });
  return out;
};

/** Plan facts with nothing planned but what a test gives. */
function planOf(p: Partial<PlanFacts>): PlanFacts {
  const cells = p.cells ?? [];
  return {
    cells,
    passages: [],
    boundaries: [],
    objects: [],
    mounted: new Set(),
    organic: new Set(),
    sunkByPlan: new Set(),
    spans: new Set(),
    levelBase: [0],
    cellAt: (li, x, z) =>
      cells.find((c) => c.levelIndex === li && c.x0 === Math.floor(x) && c.z0 === Math.floor(z)) ?? null,
    ...p,
  };
}

const cell = (x: number, z: number, o: Partial<PlanCell> = {}): PlanCell => ({
  levelIndex: 0,
  cell: [x, z],
  x0: x,
  z0: z,
  top: 0.5,
  floor: true,
  open: true,
  link: false,
  roofedBy: null,
  roofedFloor: 0.5,
  ...o,
});

const codes = (
  scene: Scene,
  plan: PlanFacts | null,
  only: CheckCode,
): ReturnType<typeof runChecks>["findings"] => runChecks(scene, plan, { only: [only] }).findings;

describe("scene space", () => {
  it("meets a piece's mesh on vertical and level rays, turned or not", () => {
    const scene = sceneOf([{ min: [0, 0, 0], max: [2, 1, 1], rot: 90 }]);
    const space = new SceneSpace(scene);
    // turned a quarter, the 2 × 1 block covers x 0.5..1.5, z -0.5..1.5
    expect(space.column(1, 1.2, -5, 5).map((h) => h.at)).toEqual([1, 0]);
    expect(space.column(1.8, 0.2, -5, 5)).toEqual([]);
    const hit = space.ray({ x: -1, y: 0.5, z: 1 }, { x: 1, y: 0, z: 0 }, 5);
    expect(hit?.at).toBeCloseTo(1.5, 6);
    expect(space.ray({ x: -1, y: 1.5, z: 1 }, { x: 1, y: 0, z: 0 }, 5)).toBeNull();
  });
});

describe("floating and sunk", () => {
  it("passes a crate on the floor and a torch on a wall; flags a crate in the air with the air under it", () => {
    const ok = sceneOf([
      ...floor(0, 3, 0, 3),
      { name: "crate", min: [1.2, 0.5, 1.2], max: [1.8, 1.1, 1.8] },
      { name: "wall", min: [0, 0.5, 2.9], max: [3, 2.5, 3], role: "wall", cls: "wall", element: "w" },
      { name: "Torch wall wood stone on", min: [1.4, 1.5, 2.7], max: [1.6, 1.9, 2.85] },
    ]);
    expect(codes(ok, null, "floating")).toEqual([]);
    const bad = sceneOf([
      ...floor(0, 3, 0, 3),
      { name: "crate", min: [1.2, 1.0, 1.2], max: [1.8, 1.6, 1.8] },
    ]);
    const f = codes(bad, null, "floating");
    expect(f).toHaveLength(1);
    expect(f[0]?.measure["gap"]).toBeCloseTo(0.5, 2);
    expect(f[0]?.pieces.map((p) => p.name)).toEqual(["crate"]);
  });

  it("names the box top a prop stands on when it is above the piece's real surface", () => {
    // a bench whose box reaches 1.5 (a back board) with its work surface at 1.0, and a jug at the box top
    const bad = sceneOf([
      ...floor(0, 2, 0, 2),
      { name: "bench top", min: [0.2, 0.5, 0.2], max: [1.8, 1.0, 1.8], element: "bench" },
      { name: "bench back", min: [0.2, 0.5, 1.7], max: [1.8, 1.5, 1.8], element: "bench" },
      { name: "jug", min: [0.9, 1.5, 0.9], max: [1.1, 1.8, 1.1] },
    ]);
    const f = codes(bad, null, "floating");
    expect(f).toHaveLength(1);
    expect(f[0]?.measure["gap"]).toBeCloseTo(0.5, 2);
    expect(f[0]?.message).toContain("bench top");
  });

  it("flags a loose piece mostly under the floor, not organic dressing", () => {
    const sunk = sceneOf([
      ...floor(0, 2, 0, 2),
      { name: "chest", min: [0.6, 0.0, 0.6], max: [1.4, 0.6, 1.4] },
    ]);
    expect(codes(sunk, null, "sunk").map((x) => x.pieces[0]?.name)).toEqual(["chest"]);
    const plant = sceneOf([
      ...floor(0, 2, 0, 2),
      { name: "bush", cls: "plant", min: [0.6, 0.0, 0.6], max: [1.4, 0.6, 1.4] },
    ]);
    expect(codes(plant, null, "sunk")).toEqual([]);
  });
});

describe("clash", () => {
  it("flags two loose pieces of different elements that run into each other, not neighbours or a chest on a rug", () => {
    const bad = sceneOf([
      ...floor(0, 3, 0, 3),
      { name: "barrel", min: [0.5, 0.5, 0.5], max: [1.5, 1.5, 1.5] },
      { name: "crate", min: [1.0, 0.5, 0.5], max: [2.0, 1.5, 1.5] },
    ]);
    expect(codes(bad, null, "clash")).toHaveLength(1);
    const ok = sceneOf([
      ...floor(0, 3, 0, 3),
      { name: "barrel", min: [0.5, 0.5, 0.5], max: [1.5, 1.5, 1.5] },
      { name: "crate", min: [1.5, 0.5, 0.5], max: [2.5, 1.5, 1.5] },
      { name: "rug", min: [0.2, 0.5, 0.2], max: [2.8, 0.55, 2.8] },
    ]);
    expect(codes(ok, null, "clash")).toEqual([]);
  });
});

describe("shell gaps", () => {
  const run = {
    owner: "house",
    levelIndex: 0,
    kind: "wall" as const,
    a: { x: 0, y: 0, z: 0 },
    b: { x: 3, y: 0, z: 0 },
  };
  const boundary = {
    ...run,
    outward: { x: 0, y: 0, z: -1 },
    heights: [0.8, 1.4],
    cells: [
      [0, 0],
      [1, 0],
      [2, 0],
    ] as Array<readonly [number, number]>,
  };
  it("measures a gap of known width in a wall where no opening is planned", () => {
    const scene = sceneOf([
      { name: "wall", min: [0, 0.5, -0.1], max: [1, 2.5, 0.1], role: "wall", cls: "wall" },
      { name: "wall", min: [1.6, 0.5, -0.1], max: [3, 2.5, 0.1], role: "wall", cls: "wall" },
    ]);
    const f = codes(scene, planOf({ boundaries: [boundary] }), "shell_gap");
    expect(f).toHaveLength(1);
    expect(f[0]?.measure["width"]).toBeCloseTo(0.6, 1);
    expect(f[0]?.severity).toBe("fault");
  });
  it("passes a whole wall, and a seam narrower than a hand", () => {
    const scene = sceneOf([
      { name: "wall", min: [0, 0.5, -0.1], max: [1.45, 2.5, 0.1], role: "wall", cls: "wall" },
      { name: "wall", min: [1.55, 0.5, -0.1], max: [3, 2.5, 0.1], role: "wall", cls: "wall" },
    ]);
    expect(codes(scene, planOf({ boundaries: [boundary] }), "shell_gap")).toEqual([]);
  });
});

describe("surfaces", () => {
  it("flags a planned floor cell with its tile missing", () => {
    const tiles = floor(0, 3, 0, 1).filter((s) => s.min[0] !== 1);
    const plan = planOf({ cells: [cell(0, 0), cell(1, 0), cell(2, 0)] });
    const f = codes(sceneOf(tiles), plan, "deck_hole");
    expect(f.map((x) => x.where.cells)).toEqual([[[1, 0]]]);
    expect(codes(sceneOf(floor(0, 3, 0, 1)), plan, "deck_hole")).toEqual([]);
  });
  it("flags a planned hole that is floored over", () => {
    const plan = planOf({ cells: [cell(1, 0, { floor: false })] });
    expect(codes(sceneOf(floor(0, 3, 0, 1)), plan, "floor_over_open")).toHaveLength(1);
  });
  it("flags a roofed building's cells that see the sky", () => {
    const plan = planOf({ cells: [cell(0, 0, { roofedBy: "b" }), cell(1, 0, { roofedBy: "b" })] });
    const roof: Spec = {
      name: "roof",
      min: [0, 3, 0],
      max: [1, 3.3, 1],
      role: "wall",
      cls: "roof",
      layer: "roof",
    };
    const f = codes(sceneOf([...floor(0, 2, 0, 1), roof]), plan, "roof_open");
    expect(f.map((x) => x.where.cells)).toEqual([[[1, 0]]]);
  });
});

describe("facing", () => {
  // a ship 10 long (east) and 4 wide, a gun on its north side and a helm on its deck
  const hull: Spec[] = [
    { name: "hull", min: [0, 0, 0], max: [10, 1, 4], element: "ship", role: "feature", cls: "wall" },
  ];
  const plan = planOf({ objects: [{ id: "ship", heading: { x: 1, y: 0, z: 0 } }] });
  it("passes a gun pointing outboard and a helm facing the way the ship goes", () => {
    const scene = sceneOf([
      ...hull,
      // "ship cannon static": front +z at rot 0 (north, out of the north side)
      { name: "ship cannon static", min: [4.7, 1, 3.2], max: [5.3, 1.5, 3.8], element: "ship@deck" },
      // "Ship floor Steering wheel": front -z at rot 0; turned 90 clockwise -z points west... so 270 points east
      {
        name: "Ship floor Steering wheel",
        min: [1.5, 1, 1.5],
        max: [2.5, 2, 2.5],
        element: "ship@deck",
        rot: 270,
      },
    ]);
    expect(codes(scene, plan, "facing")).toEqual([]);
  });
  it("flags a gun pointing inboard and a helm facing aft", () => {
    const scene = sceneOf([
      ...hull,
      {
        name: "ship cannon static",
        min: [4.7, 1, 3.2],
        max: [5.3, 1.5, 3.8],
        element: "ship@deck",
        rot: 180,
      },
      {
        name: "Ship floor Steering wheel",
        min: [1.5, 1, 1.5],
        max: [2.5, 2, 2.5],
        element: "ship@deck",
        rot: 90,
      },
    ]);
    const f = codes(scene, plan, "facing");
    expect(f.map((x) => x.pieces[0]?.name).sort()).toEqual([
      "Ship floor Steering wheel",
      "ship cannon static",
    ]);
    expect(f.every((x) => x.severity === "fault")).toBe(true);
  });
});

describe("blocked ways", () => {
  const door = {
    id: "d1",
    kind: "door",
    levelIndex: 0,
    a: { x: 1, y: 0.5, z: 0 },
    b: { x: 2, y: 0.5, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    width: 1,
  };
  it("flags a door with a barrel in it, not the door's own leaf", () => {
    const leaf: Spec = {
      name: "door",
      min: [1, 0.5, -0.05],
      max: [2, 2.5, 0.05],
      role: "opening",
      cls: "opening",
      element: "d1",
    };
    expect(codes(sceneOf([leaf]), planOf({ passages: [door] }), "way_blocked")).toEqual([]);
    const barrel: Spec = { name: "barrel", min: [1.2, 0.5, -0.4], max: [1.8, 1.4, 0.4] };
    const f = codes(sceneOf([leaf, barrel]), planOf({ passages: [door] }), "way_blocked");
    expect(f).toHaveLength(1);
    expect(f[0]?.pieces.map((p) => p.name)).toEqual(["barrel"]);
  });
});

describe("findings out", () => {
  it("clusters, frames and marks findings, and tells new from fixed between builds", () => {
    const before = sceneOf([
      ...floor(0, 4, 0, 4),
      { name: "crate", min: [1.2, 1.0, 1.2], max: [1.8, 1.6, 1.8] },
    ]);
    const after = sceneOf([
      ...floor(0, 4, 0, 4),
      { name: "crate", min: [2.2, 1.0, 2.2], max: [2.8, 1.6, 2.8] },
    ]);
    const a = runChecks(before, null).findings;
    const b = runChecks(after, null).findings;
    const d = compareFindings(a, b);
    expect([d.added.length, d.fixed.length, d.unchanged]).toEqual([1, 1, 0]);
    expect(compareFindings(a, a)).toEqual({ added: [], fixed: [], unchanged: 1 });
    const clusters = clusterFindings(a);
    expect(clusters).toHaveLength(1);
    const c = clusters[0];
    if (!c) return;
    const spec = clusterShot(before, a, c, 1, { width: 96, height: 72 });
    expect(spec.id).toBe("finding-1");
    const img = markedPicture(before, a, c, spec);
    // the crate is tinted magenta where it shows
    let tinted = 0;
    for (let k = 0; k < img.idAt.length; k++)
      if (img.idAt[k] === 16 && (img.rgba[k * 4] ?? 0) > 150 && (img.rgba[k * 4 + 1] ?? 255) < 120) tinted++;
    expect(tinted).toBeGreaterThan(0);
  });

  it("measures a big scene without looking at every pair (time logged)", () => {
    // 200 × 150 tiles with a crate on every other tile: 45,000 pieces; SCENE3D_BIG=1: 400 × 500, 300,000 pieces
    const big = process.env["SCENE3D_BIG"] === "1";
    const specs: Spec[] = [];
    for (let x = 0; x < (big ? 400 : 200); x++)
      for (let z = 0; z < (big ? 500 : 150); z++) {
        specs.push({
          name: "floor",
          min: [x, 0, z],
          max: [x + 1, 0.5, z + 1],
          role: "floor",
          cls: "floor",
          element: "f",
        });
        if ((x + z) % 2 === 0)
          specs.push({ name: "crate", min: [x + 0.2, 0.5, z + 0.2], max: [x + 0.8, 1.0, z + 0.8] });
      }
    const scene = sceneOf(specs);
    // every tile planned as floor (the plan-reading checks walk every cell)
    const cells = specs.filter((s) => s.name === "floor").map((s) => cell(s.min[0], s.min[2]));
    const t = performance.now();
    const r = runChecks(scene, planOf({ cells }), { now: () => performance.now() });
    const ms = performance.now() - t;
    console.log(`checks over ${String(scene.instances.length)} pieces: ${String(Math.round(ms))} ms`, r.ms);
    expect(r.findings).toEqual([]);
    expect(ms).toBeLessThan(big ? 600_000 : 60_000);
  }, 900_000);
});
