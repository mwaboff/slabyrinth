/**
 * The relief terrain ops (part of step 4, terrain "over"): platforms, stairs ops and rock ramps, uneven ground and
 * outcrops, which raise, lower and roughen floor the areas have opened.
 * Reads: each op, the cells' state, heights, floors and flags, the level base and plan kind (natural or built
 * ground). Writes: cell heights and floors, the grid's stair edges (flights that resolve/level/edges.ts turns into
 * stair edges once the heights are final), and its own record, ReliefRecords: `ramps` and `outcrops` (records on the
 * resolved level).
 */
import type { Material, TerrainOp, Vec2 } from "../../contracts/plan";
import { MATERIALS, PLAN_LIMITS } from "../../contracts/plan";
import type { ResolvedLevel } from "../../contracts/resolved";
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import { forEachMaskCell } from "../../gen/mask";
import { ValueNoise } from "../../gen/noise";
import { bandOffsets, rasterPolyline, rasterizeShape } from "../../gen/shapes";
import { elementSeed, subSeed } from "../../util/hash";
import { accentTop } from "../interiorFloors";
import { isNaturalGround } from "../materials";
import { breakStraightSteps, chamferCorners, organicTiers, roughenLumps } from "../organic";
import type { ResolveGrid } from "./grid";

/** What the relief ops leave on the resolved level. Written only here; read by feature placement and the output. */
export class ReliefRecords {
  /** Rock ramps laid by stairs ops in style "ramp" (generator 2). */
  readonly ramps: NonNullable<ResolvedLevel["ramps"]> = [];
  /** Outcrops: the cells they raised and their peak (generator 3 dresses them). */
  readonly outcrops: NonNullable<ResolvedLevel["outcrops"]> = [];
}

/** A flight from cell `start` stepping by (dx,dy) through `cells` (in order): stair edges where heights differ. */
function flight(work: ResolveGrid, cells: number[]): void {
  for (let k = 1; k < cells.length; k++) work.addStairEdge(cells[k - 1] as number, cells[k] as number);
}

export function applyPlatform(
  work: ResolveGrid,
  op: Extract<TerrainOp, { op: "platform" }>,
  path: string,
): void {
  const cells = work
    .shapeCells(op.shape, "terrain", path, op.id)
    .filter((i) => work.state[i] === CELL.OPEN && ((work.flags[i] as number) & CELL_FLAG.BRIDGE) === 0);
  if (cells.length === 0) {
    work.issue(
      "warning",
      "no_effect",
      `platform "${op.id}" changed nothing: its shape covers no open floor`,
      {
        path,
        elementId: op.id,
        hint: "put it inside an area (a platform raises or sinks floor that an area has opened); list it after the areas",
      },
    );
    return;
  }
  // ragged (natural) contours: the distance to the edge wanders with noise, then tiers are relaxed so neighbours
  // never differ by more than one tier
  // generator 3: in a natural or cave level a platform is rock with a ragged outline unless the plan asks for worked
  // stone (a built material, or an explicit clean edge)
  const wild = work.profile.wildPlatforms && (work.level.base.type === "ground" || work.plan.kind === "cave");
  const worked = [op.material, op.topMaterial].some((m) => m !== undefined && !isNaturalGround(m));
  const rockDefault = wild && !worked && work.plan.kind === "cave" && op.material === undefined;
  const material: Material | undefined = rockDefault ? "rock" : op.material;
  const natural = material !== undefined && isNaturalGround(material);
  const ragged =
    work.profile.raggedTerrainEdges &&
    (op.edge ??
      ((work.level.base.type === "ground" && natural) || (wild && !worked) ? "ragged" : "clean")) ===
      "ragged";
  // natural hills default to few bold rises (two terraces 2.5 tiles apart, a few cells deep), not many small steps;
  // a dais or built terrace keeps the small defaults
  const bold = ragged && natural;
  let tiers = op.tiers ?? (bold ? 2 : 3);
  let riseQ = Math.round((op.rise ?? (bold ? 2.5 : 0.5)) * 4);
  let inset = op.inset ?? (bold ? 3 : 1);
  // generator 3: a gentle rise on natural ground reads as one rounded mound, not stacked half-tile plates with
  // square, stair-stepped outlines: fewer, larger steps (a tile or more each), outline rounded by the organic pass
  if (work.profile.roundedRises && ragged && natural && riseQ > 0 && riseQ < 4 && tiers > 1) {
    const total = tiers * riseQ;
    if (total >= 4) {
      tiers = Math.max(1, Math.floor(total / 4));
      riseQ = Math.round(total / tiers);
      inset = Math.max(inset, 3);
    }
  }
  // the level bounds do not count as an edge: a plateau against the map edge stays high there
  const dist = work.innerDistance(cells, true);
  const tierOf = new Map<number, number>();
  if (ragged) {
    // organic tiers: rounded, wandering, non-parallel outlines (resolve/organic.ts)
    const grow = work.growRing(cells);
    const org = organicTiers(
      cells,
      tiers,
      inset,
      subSeed(elementSeed(work.plan.seed, op.id), "contour"),
      work.organicGrid(),
      true,
      grow,
    );
    for (const i of grow) if ((org.get(i) ?? 0) >= 1) cells.push(i);
    for (const i of cells) tierOf.set(i, org.get(i) ?? 0);
  } else
    for (const i of cells) {
      const dn = dist.get(i) ?? 1;
      tierOf.set(i, Math.max(0, Math.min(tiers, Math.floor((dn - 1) / inset) + 1)));
    }
  if (ragged)
    for (let pass = 0; pass < 6; pass++)
      for (const i of cells)
        for (const j of work.neighbours4(i)) {
          const tj = j >= 0 ? tierOf.get(j) : undefined;
          if (tj !== undefined && (tierOf.get(i) as number) > tj + 1) tierOf.set(i, tj + 1);
        }
  for (const i of cells) {
    const t = tierOf.get(i) as number;
    if (t === 0) continue;
    work.height[i] = Math.max(
      PLAN_LIMITS.minHeight * 4,
      Math.min(PLAN_LIMITS.maxHeight * 4, (work.height[i] as number) + t * riseQ),
    );
    let m = t === tiers ? (op.topMaterial ?? material) : material;
    // generator 4: a top much paler than the room's floor (marble over flagstone) is a stark slab: it takes the tier's
    // own material, or the room's floor (resolve/interiorFloors.ts accentTop)
    if (m !== undefined && t === tiers && op.topMaterial !== undefined && work.profile.accentTops) {
      const ord = work.mat[i] as number;
      m = accentTop(m, ord > 0 ? MATERIALS[ord - 1] : undefined, material);
    }
    if (m !== undefined) work.setMaterial(i, m);
  }
  const top = Math.max(...tierOf.values());
  if (top < tiers)
    work.issue(
      "warning",
      "no_effect",
      `platform "${op.id}" only has room for ${top} of its ${tiers} tiers (the shape is too small for inset ${inset})`,
      { path, elementId: op.id, hint: "enlarge the shape, or lower tiers or inset" },
    );
  if (Math.abs(riseQ) > 4 && (op.stairs ?? []).length > 0)
    work.issue(
      "warning",
      "stairs_invalid",
      `platform "${op.id}" rises ${riseQ / 4} per tier: too steep for its stairs`,
      {
        path,
        elementId: op.id,
        hint: "use rise 1 or less per tier (0.5 reads as steps and is walkable everywhere)",
      },
    );
  // stairs: a 2-wide flight through the middle of each requested side, from outside the platform to the top tier
  const set = new Set(cells);
  const xy = cells.map((i) => work.cellXY(i));
  const x0 = Math.min(...xy.map((c) => c[0]));
  const x1 = Math.max(...xy.map((c) => c[0]));
  const y0 = Math.min(...xy.map((c) => c[1]));
  const y1 = Math.max(...xy.map((c) => c[1]));
  const cx = Math.floor((x0 + x1) / 2);
  const cy = Math.floor((y0 + y1) / 2);
  const [lo, hi] = bandOffsets(2);
  for (const side of op.stairs ?? []) {
    for (let o = lo; o <= hi; o++) {
      const seq: number[] = [];
      const vertical = side === "N" || side === "S";
      const step = side === "N" || side === "W" ? 1 : -1;
      let x = vertical ? cx + o : side === "W" ? x0 - 1 : x1 + 1;
      let y = vertical ? (side === "N" ? y0 - 1 : y1 + 1) : cy + o;
      for (let n = 0; n < 200; n++) {
        const i = work.idx(x, y);
        if (i >= 0 && (set.has(i) || seq.length === 0)) {
          if (set.has(i) || work.state[i] === CELL.OPEN) seq.push(i);
          if (set.has(i) && tierOf.get(i) === top) break;
        } else if (seq.length > 0) break;
        if (vertical) y += step;
        else x += step;
      }
      flight(work, seq);
    }
  }
}

/**
 * A rock ramp (generator 2): a band from `from` to `to` (any direction), `width` cells wide (3..6, default 4),
 * rising in half-tile steps from the low end's height to the high end's, floored with rock. Walkable everywhere
 * (no step over half a tile); a warning when it climbs faster than 1 tile per 2.5 cells.
 */
function applyRamp(
  work: ResolveGrid,
  op: Extract<TerrainOp, { op: "stairs" }>,
  path: string,
  out: ReliefRecords,
): void {
  const a = work.idx(op.from[0], op.from[1]);
  const b = work.idx(op.to[0], op.to[1]);
  if (a < 0 || b < 0 || work.state[a] !== CELL.OPEN || work.state[b] !== CELL.OPEN) {
    work.issue("warning", "stairs_invalid", `ramp "${op.id}" needs open floor at both ends`, {
      path,
      elementId: op.id,
      hint: "start it on the low ground and end it on the high ground",
    });
    return;
  }
  const h0 = work.height[a] as number;
  const h1 = work.height[b] as number;
  const [fx, fy] = op.from;
  const [tx, ty] = op.to;
  const len = Math.hypot(tx - fx, ty - fy);
  if (len > 0 && Math.abs(h1 - h0) / 4 > len / 2.5)
    work.issue(
      "warning",
      "stairs_invalid",
      `ramp "${op.id}" climbs ${Math.abs(h1 - h0) / 4} tiles over ${Math.round(len)} cells: steeper than 1 tile per 2.5 cells`,
      {
        path,
        elementId: op.id,
        hint: `make it at least ${Math.ceil((Math.abs(h1 - h0) / 4) * 2.5)} cells long, diagonal to the cliff`,
      },
    );
  const width = Math.max(3, Math.min(6, op.width ?? 4));
  const cells: Vec2[] = [];
  forEachMaskCell(rasterPolyline([op.from, op.to], width, work.rasterClip()), (x, y) => {
    const i = work.idx(x, y);
    if (i < 0 || work.state[i] !== CELL.OPEN) return;
    if (((work.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE)) !== 0) return;
    const t =
      len > 0 ? Math.max(0, Math.min(1, ((x - fx) * (tx - fx) + (y - fy) * (ty - fy)) / (len * len))) : 0;
    work.height[i] = h0 + 2 * Math.round(((h1 - h0) * t) / 2);
    work.setMaterial(i, "rock");
    cells.push([x, y]);
  });
  if (cells.length > 0) out.ramps.push({ id: op.id, cells, from: [fx, fy], to: [tx, ty] });
}

export function applyStairsOp(
  work: ResolveGrid,
  op: Extract<TerrainOp, { op: "stairs" }>,
  path: string,
  out: ReliefRecords,
): void {
  if (op.style === "ramp" && work.profile.ramps) {
    applyRamp(work, op, path, out);
    return;
  }
  const [fx, fy] = op.from;
  const [tx, ty] = op.to;
  if (fx !== tx && fy !== ty) {
    work.issue("warning", "stairs_invalid", `stairs "${op.id}" must run along one row or column`, {
      path,
      elementId: op.id,
      hint: `use to: [${tx},${fy}] or [${fx},${ty}]`,
    });
    return;
  }
  const n = Math.abs(tx - fx) + Math.abs(ty - fy);
  const dx = Math.sign(tx - fx);
  const dy = Math.sign(ty - fy);
  const [lo, hi] = bandOffsets(op.width ?? 1);
  let placed = 0;
  for (let o = lo; o <= hi; o++) {
    const ox = dx === 0 ? o : 0;
    const oy = dx === 0 ? 0 : o;
    const a = work.idx(fx + ox, fy + oy);
    const b = work.idx(tx + ox, ty + oy);
    if (a < 0 || b < 0 || work.state[a] !== CELL.OPEN || work.state[b] !== CELL.OPEN || n === 0) continue;
    const h0 = work.deckHeightOf(a) ?? (work.height[a] as number);
    const h1 = work.deckHeightOf(b) ?? (work.height[b] as number);
    if (Math.abs(h1 - h0) > 4 * n) {
      work.issue(
        "warning",
        "stairs_invalid",
        `stairs "${op.id}" climb ${(h1 - h0) / 4} tiles over ${n} cell${n > 1 ? "s" : ""}: steeper than 1 tile per cell`,
        {
          path,
          elementId: op.id,
          hint: `start or end it further out: it needs at least ${Math.ceil(Math.abs(h1 - h0) / 4)} cells between from and to`,
        },
      );
    }
    const seq: number[] = [a];
    for (let k = 1; k < n; k++) {
      const i = work.idx(fx + ox + dx * k, fy + oy + dy * k);
      if (i < 0) break;
      if (work.state[i] !== CELL.OPEN) {
        work.state[i] = CELL.OPEN;
        work.mat[i] = work.mat[a] as number;
        work.struct[i] = work.struct[a] as number;
        work.disp[i] = work.disp[a] as number;
        work.theme[i] = work.theme[a] as number;
      }
      work.flags[i] = (work.flags[i] as number) & ~CELL_FLAG.NO_FLOOR;
      if (work.mat[i] === 0) work.mat[i] = work.mat[a] as number;
      work.height[i] = h0 + Math.round(((h1 - h0) * k) / n);
      seq.push(i);
    }
    seq.push(b);
    flight(work, seq);
    placed++;
  }
  if (placed === 0)
    work.issue(
      "warning",
      "no_effect",
      `stairs "${op.id}" changed nothing: from and to must both be open floor`,
      {
        path,
        elementId: op.id,
        hint: "put both ends on floor cells (the cells in between may be anything)",
      },
    );
}

export function applyUneven(work: ResolveGrid, op: Extract<TerrainOp, { op: "uneven" }>, path: string): void {
  const region = op.shape
    ? work.shapeCells(op.shape, "terrain", path, op.id)
    : Array.from({ length: work.n }, (_, i) => i);
  const excluded = new Set<number>();
  for (const s of op.exclude ?? [])
    forEachMaskCell(rasterizeShape(s, { planSeed: work.plan.seed, clip: work.rasterClip() }), (x, y) => {
      const i = work.idx(x, y);
      if (i >= 0) excluded.add(i);
    });
  const cells = region.filter(
    (i) =>
      !excluded.has(i) &&
      work.state[i] === CELL.OPEN &&
      ((work.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE | CELL_FLAG.WATER)) === 0,
  );
  if (cells.length === 0) {
    work.issue("warning", "no_effect", `uneven "${op.id}" changed nothing: no open dry floor in its shape`, {
      path,
      elementId: op.id,
      hint: "give it a shape inside an area, or shrink exclude",
    });
    return;
  }
  const seed = elementSeed(work.plan.seed, op.id, op.seed);
  const noise = new ValueNoise(subSeed(seed, "uneven"));
  const scale = op.scale ?? 8;
  const amountQ = Math.round((op.amount ?? 0.5) * 4);
  const set = new Set(cells);
  // taper to nothing over 3 cells at the edge of the region, so it meets the floor around it smoothly
  const dist = work.innerDistance(cells);
  const delta = new Map<number, number>();
  for (const i of cells) {
    const [x, y] = work.cellXY(i);
    const taper = Math.min(1, ((dist.get(i) ?? 1) - 1) / 3);
    // whole half tiles: a quarter-tile step only reads as a crack in game (round 3); generator 2 rounds the band
    // outlines below so they read as gentle banks, not square stair-steps
    delta.set(i, 2 * Math.round((noise.sample(x / scale, y / scale) - 0.5) * amountQ * taper));
  }
  // generator 2: the band edges wander like an organic outline (no straight or square stair-steps)
  if (work.profile.organicBands) {
    const tiers = new Map<number, number>();
    for (const i of cells) tiers.set(i, Math.round((delta.get(i) as number) / 2));
    breakStraightSteps(tiers, work.organicGrid(), subSeed(seed, "bands"));
    chamferCorners(tiers, work.organicGrid());
    // generator 3: small lumps lose their square corners and their straight sides are bitten
    if (work.profile.roughenedLumps) roughenLumps(tiers, work.organicGrid(), subSeed(seed, "lumps"));
    for (const i of cells) delta.set(i, 2 * (tiers.get(i) ?? 0));
  }
  // walkable: neighbours in the region never differ by more than 2 quarters (relaxation, then applied)
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const i of cells) {
      let lo2 = -Infinity;
      let hi2 = Infinity;
      for (const j of work.neighbours4(i)) {
        if (j < 0 || !set.has(j)) continue;
        // an existing step (a cliff or a riser the plan built) stays as it is: smoothing across it would drag the
        // low ground up into a ramp that ends in a straight wall at the edge of the shape
        if (Math.abs((work.height[j] as number) - (work.height[i] as number)) > 2) continue;
        const base = (work.height[j] as number) + (delta.get(j) as number) - (work.height[i] as number);
        lo2 = Math.max(lo2, base - 2);
        hi2 = Math.min(hi2, base + 2);
      }
      const d = delta.get(i) as number;
      const c = Math.max(lo2, Math.min(hi2, d));
      if (Number.isFinite(c) && c !== d) {
        delta.set(i, Math.round(c));
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const i of cells) work.height[i] = (work.height[i] as number) + (delta.get(i) as number);
}

export function applyOutcrop(
  work: ResolveGrid,
  op: Extract<TerrainOp, { op: "outcrop" }>,
  path: string,
  out: ReliefRecords,
): void {
  let n = 0;
  const riseQ = Math.round((op.height ?? 2) * 4);
  let cells = work
    .shapeCells(op.shape, "terrain", path, op.id)
    .filter(
      (i) =>
        work.state[i] === CELL.OPEN &&
        ((work.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE)) === 0,
    );
  // generator 3: a small natural rise is not a rectangle: its corners are cut (twice on larger ones) and its sides
  // bitten. Only ever removes cells, so no route is closed that the shape did not already close.
  if (work.profile.roughenedLumps && cells.length >= 6) {
    const tiers = new Map<number, number>(cells.map((i) => [i, 1]));
    const lumpSeed = subSeed(elementSeed(work.plan.seed, op.id), "outcrop-lumps");
    roughenLumps(tiers, work.organicGrid(), lumpSeed);
    if (cells.length >= 30) roughenLumps(tiers, work.organicGrid(), subSeed(lumpSeed, "again"));
    const kept = cells.filter((i) => (tiers.get(i) ?? 0) > 0);
    if (kept.length >= Math.ceil(cells.length * 0.55)) cells = kept;
  }
  const dist = work.innerDistance(cells);
  const noise = new ValueNoise(subSeed(elementSeed(work.plan.seed, op.id), "outcrop"));
  const kept: number[] = [];
  let peak = 0;
  for (const i of cells) {
    const [x, y] = work.cellXY(i);
    const nz = noise.sample(x / 1.7, y / 1.7);
    const d = dist.get(i) ?? 1;
    // ragged edge: some rim cells stay floor; heights taper from the core to the rim and vary by ±0.5
    if (d === 1 && nz < 0.35 && cells.length > 4) continue;
    const taper = Math.min(1, (d + 0.5) / 2.5);
    const q = Math.max(2, 2 * Math.round((riseQ * taper + (nz - 0.5) * 4) / 2));
    work.height[i] = Math.min(PLAN_LIMITS.maxHeight * 4, (work.height[i] as number) + q);
    work.setMaterial(i, op.material ?? "rock");
    kept.push(i);
    peak = Math.max(peak, q);
    n++;
  }
  if (kept.length > 0)
    out.outcrops.push({
      id: op.id,
      cells: kept.sort((a, b) => a - b).map((i) => work.cellXY(i)),
      peak: peak / 4,
    });
  if (n === 0)
    work.issue("warning", "no_effect", `outcrop "${op.id}" changed nothing: its shape covers no open floor`, {
      path,
      elementId: op.id,
      hint: "place it on open floor (inside an area, or on ground)",
    });
}
