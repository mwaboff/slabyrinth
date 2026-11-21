/**
 * Realize, floor passes: the floor tiles of every open cell (greedy tiling, floor families, road crossings), road
 * drains, water beds, the floor under bridge decks, and light props on liquid surfaces.
 * Reads: the level's cells, roads, bridges and features; the rock band's low ground (cliffBand.ts), `outcropCells`.
 * Writes: floor placements (and glow features). Returns the water cells (layFloors, read by layWaterBeds) and the
 * ground under bridge decks (layGroundUnderDecks, read by fill.ts).
 */
import type { Material } from "../../contracts/plan";
import { CELL_FLAG } from "../../contracts/resolved";
import type { ResolvedVariant, RoleResolution, VariantFilter } from "../../palette/resolve";
import { createFamilyPicker, type FloorFamily } from "../../resolve/floorFamilies";
import { isWater } from "../../resolve/materials";
import { axisPosition } from "../../resolve/road";
import { h32 } from "../geometry";
import type { RockBand } from "./cliffBand";
import { isCliffGround, type RealizeLevel } from "./level";
import type { LevelCell } from "../../resolve/levelGrid";

/** Water cells ([x, y]) the floor pass leaves for the bed pass, in the order it met them. */
export type WaterCells = ReadonlyArray<readonly [number, number]>;
/** The ground under each bridge deck cell ("x,y", relative tiles), for the faces round it (fill.ts). */
export type GroundUnderDecks = ReadonlyMap<string, number>;

/** Road markings (generator 2 roads): sparse drains along the kerb, data rather than code. */
const ROAD_MARKINGS = {
  drain: {
    /** Cells from the start of a kerb line to the first drain (seeded within this range). */
    first: [5, 14],
    /** Cells between drains (seeded within this range per gap). */
    every: [20, 30],
    /** Kerb lines shorter than this get none; shorter than every[0], one with this chance. */
    minLine: 8,
    shortChance: 0.4,
  },
} as const;

/**
 * Floor families that only grow where something causes them (owner's v6 and watchtower runs, 2026-11-20: reddish
 * leaf-litter squares scattered over open grass): under trees, along paths, at the foot of a rise, round a camp.
 */
const CAUSED_FAMILIES = new Set(["lush"]);

/** Features that cause litter and worn ground round them. */
const CAUSE_FEATURES = new Set([
  "cluster_tall",
  "tree",
  "pine_tree",
  "dead_tree",
  "tree_large",
  "campfire",
  "fire_pit",
  "tent",
]);

/** The floor family a cell takes, from the families of its floor role. */
type FamilyAt = (fams: FloorFamily[], x: number, y: number) => string;

/** What the floor tiling of one level shares across its cells. */
interface FloorPass {
  lv: RealizeLevel;
  band: RockBand;
  /** Cells already covered or given up (local index). */
  used: Set<number>;
  familyOf: FamilyAt;
  /** Road axis of every carriageway cell ("x,y"): road tiles keep one orientation along it. */
  roadAxisAt: ReadonlyMap<string, "h" | "v">;
}

// ── floors (greedy tiling) ──
export function layFloors(lv: RealizeLevel, band: RockBand): WaterCells {
  const { L, V, outcropCells } = lv;
  const waterCells: Array<[number, number]> = [];
  const roadAxisAt = new Map<string, "h" | "v">();
  for (const rd of L.roads ?? [])
    for (const [x, y] of rd.carriageway) roadAxisAt.set(`${x},${y}`, axisPosition(rd.axis, x, y).dir);
  const crossingAxis = new Map<string, "h" | "v">();
  for (const rd of L.roads ?? [])
    for (const cr of rd.crossings) for (const [x, y] of cr.cells) crossingAxis.set(`${x},${y}`, cr.axis);
  const pass: FloorPass = { lv, band, used: new Set(), familyOf: floorFamilyAt(lv), roadAxisAt };
  const { used } = pass;
  for (let ly = 0; ly < V.h; ly++) {
    for (let lx = 0; lx < V.w; lx++) {
      const x = L.bounds.x + lx;
      const y = L.bounds.y + ly;
      const c = V.cell(x, y);
      if (!c.floor || used.has(ly * V.w + lx)) continue;
      // outcrops are solid rock columns (built in the cliff pass), not floor tiles
      if (outcropCells.has(`${x},${y}`)) {
        used.add(ly * V.w + lx);
        continue;
      }
      // water: TaleSpire's water is the board's water plane; the slab carries the channel's bed (+ optional surface)
      if (c.material !== null && isWater(c.material)) {
        used.add(ly * V.w + lx);
        waterCells.push([x, y]);
        continue;
      }
      const crossAxis = crossingAxis.get(`${x},${y}`);
      if (crossAxis !== undefined && layCrossing(lv, c, x, y, crossAxis)) {
        used.add(ly * V.w + lx);
        continue;
      }
      if (!layFloorTile(pass, c, lx, ly)) used.add(ly * V.w + lx);
    }
  }
  return waterCells;
}

/**
 * The floor family of a cell. Generator 3 (`floorFamilies`): one dominant family, a tonally close second only in
 * feathered patches with a cause (resolve/floorFamilies.ts). Before it: caused families only near their cause (within
 * two cells of a tree, a camp, a path or the foot of a rise), with a feathered, noisy edge.
 */
function floorFamilyAt(lv: RealizeLevel): FamilyAt {
  const { L } = lv;
  const { seed, profile, familyAt, familyWarp } = lv.ctx;
  if (profile.floorFamilies) return createFamilyPicker(L, seed);
  const causeDist = causeDistances(lv);
  return (fams, x, y) => {
    const caused = fams.filter((q) => CAUSED_FAMILIES.has(q.name));
    if (caused.length === 0) return familyAt(fams, x, y);
    const d = causeDist.get(`${x},${y}`) ?? 9;
    const j = familyWarp.sample(x / 2.5 + 11, y / 2.5 + 3);
    if ((d === 0 && j > 0.45) || (d === 1 && j > 0.62) || (d === 2 && j > 0.8))
      return (caused[0] as { name: string }).name;
    return familyAt(
      fams.filter((q) => !CAUSED_FAMILIES.has(q.name)),
      x,
      y,
    );
  };
}

/** Distance (cells, up to 2) from each cell ("x,y") to the nearest cause of a caused family. */
function causeDistances(lv: RealizeLevel): Map<string, number> {
  const { L, V } = lv;
  const causeDist = new Map<string, number>();
  const src: Array<[number, number]> = [];
  for (const f of L.features)
    if (CAUSE_FEATURES.has(f.type))
      for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
        for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) src.push([x, y]);
  for (let ly = 0; ly < V.h; ly++)
    for (let lx = 0; lx < V.w; lx++) {
      const x = L.bounds.x + lx;
      const y = L.bounds.y + ly;
      const c = V.cell(x, y);
      if (!c.floor) continue;
      const i = ly * V.w + lx;
      if (((L.cells.flags[i] ?? 0) & CELL_FLAG.PATH) !== 0) src.push([x, y]);
      else if (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => {
          const n = V.cell(x + (dx as number), y + (dy as number));
          return n.floor && n.height - c.height >= 0.5;
        })
      )
        src.push([x, y]);
    }
  for (const [sx, sy] of src)
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const k = `${sx + dx},${sy + dy}`;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if ((causeDist.get(k) ?? 9) > d) causeDist.set(k, d);
      }
  return causeDist;
}

/**
 * A crossing cell takes the theme's crossing tile (marking.crossing) AS its floor tile, turned by the road axis: a
 * thick striped tile laid on top of the road would stand as a step. False when the palette has none.
 */
function layCrossing(lv: RealizeLevel, c: LevelCell, x: number, y: number, axis: "h" | "v"): boolean {
  const { L, topOf, emit } = lv;
  const { frame, lookup, pick } = lv.ctx;
  const cr = lookup(
    L.id,
    c.theme,
    ["marking.crossing"],
    { key: "1x1", test: (q) => q.footprint[0] === 1 && q.footprint[1] === 1 },
    true,
  );
  const cv = cr ? pick(cr.variants, `${L.id}:crossing:${x}:${y}`) : undefined;
  if (!cv) return false;
  const m = frame.rectMin(x, y, 1, 1);
  emit(cv, "floor", m.x, topOf(c) - cv.geom.size.y, m.z, (axis === "h" ? 0 : 90) + cv.rot, {
    cell: [x, y],
    elementId: "crossing",
  });
  return true;
}

/** Floor material as laid: natural low ground under a rock band is rock. */
const laidMaterial = (pass: FloorPass, c: LevelCell, x: number, y: number): Material | null =>
  c.material !== null && isCliffGround(c.material) && pass.band.low.has(`${x},${y}`) ? "rock" : c.material;
/** Cells one floor piece may cover share this key. */
const tileKey = (pass: FloorPass, c: LevelCell, x: number, y: number): string =>
  `${c.theme}|${laidMaterial(pass, c, x, y) ?? ""}|${c.height}`;

/**
 * The biggest floor piece that fits from this cell (its cells free, of one key and one family), from the cell's floor
 * role. False when no piece was laid (the caller gives the cell up).
 */
function layFloorTile(pass: FloorPass, c: LevelCell, lx: number, ly: number): boolean {
  const { lv, used, familyOf } = pass;
  const { L, V, topOf, emit } = lv;
  const { seed, profile, frame, lookup, pickPatch, familiesOf } = lv.ctx;
  const x = L.bounds.x + lx;
  const y = L.bounds.y + ly;
  const role = `floor.${laidMaterial(pass, c, x, y) ?? ""}`;
  const res = lookup(L.id, c.theme, [role]);
  if (!res) return false;
  // families on natural ground only: built floors (flagstone, planks) keep their regular laying
  const fams = c.material !== null && isCliffGround(c.material) ? familiesOf(res.variants) : [];
  const fam = familyOf(fams, x, y);
  const inFam = (v: ResolvedVariant): boolean => fams.length <= 1 || (v.variant ?? "") === fam;
  const k0 = tileKey(pass, c, x, y);
  const roadDir = pass.roadAxisAt.get(`${x},${y}`);
  for (const [fw, fh] of floorFootprints(lv, res, inFam, x, y)) {
    let fits = lx + fw <= V.w && ly + fh <= V.h;
    for (let dy = 0; fits && dy < fh; dy++) {
      for (let dx = 0; fits && dx < fw; dx++) {
        const cc = V.cell(x + dx, y + dy);
        if (!cc.floor || used.has((ly + dy) * V.w + lx + dx) || tileKey(pass, cc, x + dx, y + dy) !== k0)
          fits = false;
        else if (fams.length > 1 && familyOf(fams, x + dx, y + dy) !== fam) fits = false;
      }
    }
    if (!fits) continue;
    // a candidate with no variant of that footprint but one of the transposed footprint lays that piece turned
    const ownOf = (a: number, b: number): ResolvedVariant[] =>
      res.variants.filter(
        (u) =>
          u.footprint[0] === a &&
          u.footprint[1] === b &&
          u.weight > 0 &&
          (inFam(u) || (u.variant ?? "") === ""),
      );
    const turned =
      profile.turnedFloorTiles && fw !== fh && ownOf(fw, fh).length === 0 && ownOf(fh, fw).length > 0;
    const sized = res.variants.filter((u) =>
      turned
        ? u.footprint[0] === fh && u.footprint[1] === fw
        : u.footprint[0] === fw && u.footprint[1] === fh,
    );
    // the cell's family. A family without a piece of this size tries its own smaller pieces first; one with nothing
    // smaller (a meadow made only of 8×8 tiles) uses the default family's piece of this size
    const famSized = sized.filter((u) => inFam(u) && u.weight > 0);
    if (
      famSized.length === 0 &&
      fams.length > 1 &&
      res.variants.some((u) => inFam(u) && u.weight > 0 && u.footprint[0] * u.footprint[1] < fw * fh)
    )
      continue;
    const v = pickPatch(
      famSized.length ? famSized : sized.filter((u) => (u.variant ?? "") === ""),
      x,
      y,
      `${L.id}:floor:${x}:${y}`,
    );
    if (!v) continue;
    for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) used.add((ly + dy) * V.w + lx + dx);
    const m = frame.rectMin(x, y, fw, fh);
    const rule = res.def.rotation ?? "random90";
    const r = h32(`${seed}:${L.id}:floorrot:${x}:${y}`);
    // road carriageway tiles keep one orientation along the road's axis (markings on the tiles line up)
    const steps =
      roadDir !== undefined
        ? roadDir === "h"
          ? 0
          : 6
        : rule === "fixed"
          ? 0
          : fw === fh
            ? rule === "random90" || rule === "random15"
              ? (r % 4) * 6
              : 0
            : (r % 2) * 12 + (turned ? 6 : 0);
    emit(v, "floor", m.x, topOf(c) - v.geom.size.y, m.z, steps * 15 + v.rot, {
      cell: [x, y],
      elementId: `floor:${role}`,
    });
    return true;
  }
  return false;
}

/**
 * The footprints to try from a cell, biggest first: the role's weighted pieces of the cell's family (or the default
 * family), 1x1 only when the role is not greedy. Generator 3 (`turnedFloorTiles`): a 1x2 piece may lie either way
 * (turned a quarter), the way round chosen per cell from the seed, so a field of them is not all one orientation.
 */
function floorFootprints(
  lv: RealizeLevel,
  res: RoleResolution,
  inFam: (v: ResolvedVariant) => boolean,
  x: number,
  y: number,
): Array<[number, number]> {
  const { L } = lv;
  const { seed, profile } = lv.ctx;
  const greedy = res.def.greedyTiling !== false;
  const fps = [
    ...new Set(
      res.variants
        .filter((v) => v.weight > 0 || res.variants.every((u) => u.weight <= 0))
        .filter((v) => inFam(v) || (v.variant ?? "") === "")
        .map((v) => `${v.footprint[0]}x${v.footprint[1]}`),
    ),
  ]
    .map((s) => s.split("x").map(Number) as [number, number])
    .filter(([cols, rows]) => greedy || (cols === 1 && rows === 1))
    .sort((a, b) => b[0] * b[1] - a[0] * a[1] || b[0] - a[0]);
  if (profile.turnedFloorTiles && greedy) {
    for (const [fw0, fh0] of [...fps])
      if (fw0 !== fh0 && !fps.some(([a, b]) => a === fh0 && b === fw0)) fps.push([fh0, fw0]);
    const flip = h32(`${seed}:${L.id}:floororient:${x}:${y}`) % 2 === 1;
    fps.sort((a, b) => b[0] * b[1] - a[0] * a[1] || (flip ? a[0] - b[0] : b[0] - a[0]));
  }
  return fps.length ? fps : [[1, 1]];
}

// road markings (generator 2 roads): marking.crossing on crossing cells, an occasional marking.drain on the
// carriageway beside the kerb; optional roles, the road is complete without them
export function layRoadMarkings(lv: RealizeLevel): void {
  const { L, V, topOf, emit } = lv;
  const { seed, frame, lookup, pick } = lv.ctx;
  for (const rd of L.roads ?? []) {
    const one: VariantFilter = { key: "1x1", test: (q) => q.footprint[0] === 1 && q.footprint[1] === 1 };
    const mark = (role: string, x: number, y: number, dir: "h" | "v", tag: string): boolean => {
      const c = V.cell(x, y);
      const res = lookup(L.id, c.theme, [role], one, true);
      const v = res ? pick(res.variants, `${L.id}:${tag}:${x}:${y}`) : undefined;
      if (!v) return false;
      const m = frame.rectMin(x, y, 1, 1);
      emit(v, "floor", m.x, topOf(c), m.z, (dir === "h" ? 0 : 90) + v.rot, {
        cell: [x, y],
        elementId: tag,
      });
      return true;
    };
    // crossings are laid as floor tiles in the floor pass
    for (const kl of rd.kerbLines) {
      const [dx, dy] =
        kl.side === "N" ? [0, -1] : kl.side === "S" ? [0, 1] : kl.side === "E" ? [1, 0] : [-1, 0];
      const n = Math.max(Math.abs(kl.to[0] - kl.from[0]), Math.abs(kl.to[1] - kl.from[1])) + 1;
      const sx = Math.sign(kl.to[0] - kl.from[0]);
      const sy = Math.sign(kl.to[1] - kl.from[1]);
      // sparse, irregular drains (ROAD_MARKINGS): a seeded gap from the start of the kerb line, then a jittered
      // spacing; a line shorter than the minimum spacing gets one at most, and only sometimes
      const D = ROAD_MARKINGS.drain;
      let h = h32(`${seed}:${L.id}:drain:${kl.from[0]},${kl.from[1]}:${kl.side}`);
      if (n < D.minLine || (n < D.every[0] && h % 100 >= D.shortChance * 100)) continue;
      for (let t = D.first[0] + (h % (D.first[1] - D.first[0] + 1)); t < n - 1;) {
        const x = kl.from[0] + sx * t + dx;
        const y = kl.from[1] + sy * t + dy;
        if (!mark("marking.drain", x, y, kl.side === "N" || kl.side === "S" ? "h" : "v", "drain")) break;
        h = h32(`${h}`);
        t += D.every[0] + (h % (D.every[1] - D.every[0] + 1));
      }
    }
  }
}

// water beds: bed.<water material> → bed.default → the floor of the bank beside it (never an open void)
export function layWaterBeds(lv: RealizeLevel, waterCells: WaterCells): void {
  const { L, V, topOf, emit } = lv;
  const { seed, frame, lookup, pick, addDiag } = lv.ctx;
  const bedNoted = new Set<string>();
  for (const [x, y] of waterCells) {
    const c = V.cell(x, y);
    const one: VariantFilter = { key: "1x1", test: (q) => q.footprint[0] === 1 && q.footprint[1] === 1 };
    let res = lookup(L.id, c.theme, [`bed.${c.material ?? ""}`, "bed.default"], one, true);
    if (!res) {
      let bank: Material | null = null;
      for (const [nx, ny] of [
        [x, y - 1],
        [x + 1, y],
        [x, y + 1],
        [x - 1, y],
      ] as const) {
        const n = V.cell(nx, ny);
        if (n.floor && n.material !== null && !isWater(n.material)) bank = bank ?? n.material;
      }
      res = lookup(L.id, c.theme, ["floor.gravel", `floor.${bank ?? "rock"}`, "fill.default"], one, true);
      if (!bedNoted.has(`${c.theme}|${c.material}`)) {
        bedNoted.add(`${c.theme}|${c.material}`);
        addDiag({
          severity: "warning",
          code: "asset_substituted",
          message: `No bed piece for ${c.material} in theme "${c.theme}" (bed.${c.material}, bed.default): the channel is floored with ${res?.role ?? "nothing"}`,
          levelId: L.id,
          role: `bed.${c.material}`,
        });
      }
    }
    const v = res ? pick(res.variants, `${L.id}:bed:${x}:${y}`) : undefined;
    if (v) {
      const m = frame.rectMin(x, y, 1, 1);
      const steps = (h32(`${seed}:${L.id}:floorrot:${x}:${y}`) % 4) * 6;
      emit(v, "floor", m.x, topOf(c) - v.geom.size.y, m.z, steps * 15 + v.rot, {
        cell: [x, y],
        elementId: "bed",
      });
    }
    // optional surface piece, only where the palette has one (water.<material>)
    const wr = lookup(L.id, c.theme, [`water.${c.material ?? ""}`], one, true);
    const wv = wr ? pick(wr.variants, `${L.id}:water:${x}:${y}`) : undefined;
    if (wv) {
      const m = frame.rectMin(x, y, 1, 1);
      emit(wv, "floor", m.x, topOf(c), m.z, wv.rot, { cell: [x, y], elementId: "water" });
    }
  }
}

// the ground under bridge decks: its floor tile, and its height for the cliff faces around it
export function layGroundUnderDecks(lv: RealizeLevel): GroundUnderDecks {
  const { L, V, elev, emit } = lv;
  const { seed, frame, lookup, pick } = lv.ctx;
  const groundUnder = new Map<string, number>();
  for (const b of L.bridges ?? []) {
    b.cells.forEach(([bx, by], j) => {
      const uq = b.under[j] ?? b.deck;
      groundUnder.set(`${bx},${by}`, uq / 4);
      const mat = b.underMaterial[j] ?? null;
      if (mat === null || uq >= b.deck) return;
      const c = V.cell(bx, by);
      const role = `floor.${mat}`;
      // the default family (untagged variants): patch families are for open floors
      const res = lookup(L.id, c.theme, [role], {
        key: "1x1plain",
        test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1 && (v.variant ?? "") === "",
      });
      const v = res ? pick(res.variants, `${L.id}:under:${bx}:${by}`) : undefined;
      if (!v) return;
      const m = frame.rectMin(bx, by, 1, 1);
      const steps = (h32(`${seed}:${L.id}:floorrot:${bx}:${by}`) % 4) * 6;
      emit(v, "floor", m.x, elev + uq / 4 + 0.5 - v.geom.size.y, m.z, steps * 15 + v.rot, {
        cell: [bx, by],
        elementId: `floor:${role}`,
      });
    });
  }
  return groundUnder;
}

// light props on liquid surfaces (lava glow): every third cell on a 3×3 lattice, when the palette has the role
export function layLiquidGlow(lv: RealizeLevel): void {
  const { L, V, topOf, emit } = lv;
  const { frame, lookup, pick } = lv.ctx;
  for (let ly = 0; ly < V.h; ly++) {
    for (let lx = 0; lx < V.w; lx++) {
      const x = L.bounds.x + lx;
      const y = L.bounds.y + ly;
      if (((x % 3) + 3) % 3 !== 1 || ((y % 3) + 3) % 3 !== 1) continue;
      const c = V.cell(x, y);
      if (!c.floor || c.material === null) continue;
      const res = lookup(
        L.id,
        c.theme,
        [`glow.${c.material}`, `feature.${c.material}_glow`],
        undefined,
        true,
      );
      const v = res ? pick(res.variants, `${L.id}:glow:${x}:${y}`) : undefined;
      if (!v) continue;
      const ctr = frame.point(x + 0.5, y + 0.5);
      const off =
        v.geom.originAt === "minCorner"
          ? { x: v.geom.size.x / 2, z: v.geom.size.z / 2 }
          : v.geom.boundsCenter;
      emit(v, "feature", ctr.x - off.x, topOf(c), ctr.z - off.z, v.rot, {
        cell: [x, y],
        elementId: `glow:${c.material}`,
      });
    }
  }
}
