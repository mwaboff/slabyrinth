/**
 * Realize, rock wall pass: the full-cell wall columns the wall runs gathered (generator 2: reaching down to the
 * level's lowest floor and varying in height), and the generator-3 rock mass behind and over cave walls
 * (gen/cavewall.ts), which replaces the columns it covers.
 * Reads: the full-cell columns (walls.ts), `outsideGround`, the solid shell (solidShell.ts: which solid cells the rock
 * may take), the level's edges, features and cells, the levels above (ceiling). Writes: wall and feature placements
 * (and corrects the boxes of turned tiles).
 */
import type { ThemeId } from "../../contracts/plan";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { planCaveWall, type WallFace, type WallShape } from "../../gen/cavewall";
import { ValueNoise } from "../../gen/noise";
import type { ResolvedVariant } from "../../palette/resolve";
import { h32, placementBox, rotateXZ } from "../geometry";
import { EPS, type RealizeLevel } from "./level";
import type { SolidShellPlan } from "./solidShell";
import type { FullCellColumn, FullCellColumns } from "./walls";

/** A face of the rock mass: a column cell of a cave wall, with its theme. */
type MassFace = WallFace & { theme: ThemeId };

export function layRockWalls(lv: RealizeLevel, fullCells: FullCellColumns, shellPlan: SolidShellPlan): void {
  const { L, elev } = lv;
  const { resolved, seed, profile } = lv.ctx;
  // the extra blocks never rise through the floor of a level stacked above (verify_pokes_into_level_above)
  const ceiling = resolved.levels.reduce(
    (m, o) => (o.elevation > elev + EPS ? Math.min(m, o.elevation) : m),
    Infinity,
  );
  const wallNoise = new ValueNoise(h32(`${seed}:${L.id}:walltops`));
  const massFaces: MassFace[] = [];
  /** The columns of the mass faces, built after the mass where no mass piece closes the face cell. */
  const columnLater = new Map<string, () => void>();
  for (const c of fullCells.values()) {
    const col = planColumn(lv, c, ceiling, wallNoise);
    if (!col) continue;
    // generator 3: the column is only the fill of a wall of rock mass (gen/cavewall.ts); it is built below, where no
    // mass piece closes the face cell
    if (profile.caveRockMass && c.roleName === "wall.cave_rock") {
      massFaces.push({ x: c.x, y: c.y, base: col.base, top: col.top, edgeBase: c.base, theme: c.theme });
      columnLater.set(`${c.x},${c.y}`, col.build);
    } else col.build();
  }
  if (massFaces.length > 0) layRockMass(lv, massFaces, shellPlan, ceiling, columnLater);
  // the wall columns left as fill (all of them where no mass was planned)
  for (const build of columnLater.values()) build();
}

/**
 * One full-cell column: its span and how to build it, or null when the palette has no 1x1 piece. Generator 2
 * (`rockWallSkirt`): rock walls reach down to the lowest floor of the level (nothing below the room shows from outside)
 * and vary in height like a natural cave (0, 1 or 2 extra blocks from seeded value noise).
 */
function planColumn(
  lv: RealizeLevel,
  c: FullCellColumn,
  ceiling: number,
  wallNoise: ValueNoise,
): { base: number; top: number; build: () => void } | null {
  const { L, elev, blockTurn, emit } = lv;
  /** The column's cell as its seeded picks name it. */
  const k = `${c.x},${c.y}`;
  const { seed, profile, frame, lookup, pick } = lv.ctx;
  const rockSkirt = profile.rockWallSkirt;
  const r1 = lookup(L.id, c.theme, [c.roleName], {
    key: "1x1",
    test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1,
  });
  const v = r1 ? pick(r1.variants, `${L.id}:wallblock:${k}`) : undefined;
  if (!v) return null;
  const m = frame.rectMin(c.x, c.y, 1, 1);
  let base = c.base;
  let top = c.top;
  const floorTop = c.base;
  if (rockSkirt) {
    base = Math.min(base, elev + lv.outsideGround);
    // clustered: broad noise picks masses (up to 3 blocks taller) and a few lower stretches (1 block down, never
    // below a tile above the floor), a per-cell hash breaks up runs of equal columns
    const nz =
      wallNoise.sample(c.x / 4, c.y / 4) * 0.8 + (h32(`${seed}:${c.x}:${c.y}:wt`) / 4294967296) * 0.2;
    let extra = nz < 0.22 ? -1 : nz < 0.45 ? 0 : nz < 0.62 ? 1 : nz < 0.8 ? 2 : 3;
    // generator 3: the column is the closing skin of a wall of rock mass (gen/cavewall.ts): lower, in uneven runs
    if (profile.caveRockMass && c.roleName === "wall.cave_rock") extra = nz < 0.3 ? -1 : nz < 0.72 ? 0 : 1;
    if (extra < 0 && top - v.unitHeight < floorTop + 1.5) extra = 0;
    // a column that closes the mouth of a chasm or pit (its wall reaches below the floor) is never one of the low
    // stretches, and stands at least a block taller, so nothing glows over it from inside
    if (c.base < elev + 0.5 - 0.75) extra = Math.max(extra, 1);
    while (extra > 0 && top + extra * v.unitHeight > ceiling + EPS) extra--;
    top += extra * v.unitHeight;
  }
  const n = Math.max(1, Math.ceil((top - base) / v.unitHeight - EPS));
  // generator 2: a block that would rise through the floor above is dropped to sit just under it (overlapping the
  // block below), so a stacked cave keeps its wall closed without poking into the level above
  const yAt = (s: number): number => {
    const y = base + s * v.unitHeight;
    return rockSkirt && y + v.unitHeight > ceiling + EPS && ceiling - v.unitHeight >= base - EPS
      ? ceiling - v.unitHeight
      : y;
  };
  const build = (): void => {
    for (let s = 0; s < n; s++)
      emit(v, "wall", m.x, yAt(s), m.z, v.rot + (rockSkirt ? blockTurn(v, `${k}:${s}`) : 0), {
        cell: [c.x, c.y],
        elementId: c.roleName,
      });
  };
  return { base, top: base + n * v.unitHeight, build };
}

/**
 * Generator 3 (`caveRockMass`): the rock mass behind and over the wall columns (gen/cavewall.ts), one plan per theme.
 * A face cell the mass closes loses its column (`columnLater`).
 */
function layRockMass(
  lv: RealizeLevel,
  massFaces: readonly MassFace[],
  shellPlan: SolidShellPlan,
  ceiling: number,
  columnLater: Map<string, () => void>,
): void {
  const { L, V, placements, topOf, emit, rebox } = lv;
  const { seed, profile, frame, orientation } = lv.ctx;
  const { shell } = shellPlan;
  const { edgeBlocked, taken } = massKeepClear(lv);
  const inLevelState = (x: number, y: number): number =>
    V.inBounds(x, y) ? (L.cells.state[(y - L.bounds.y) * V.w + (x - L.bounds.x)] ?? CELL.VOID) : -1;
  for (const theme of new Set(massFaces.map((f) => f.theme))) {
    const { vars, shapes } = massShapes(lv, theme);
    if (!shapes.some((s) => s.family !== "toe")) continue;
    const faces = massFaces.filter((f) => f.theme === theme);
    const plan = planCaveWall({
      seed: h32(`${seed}:${L.id}:cavemass`),
      faces,
      bounds: { x: L.bounds.x, y: L.bounds.y, w: V.w, h: V.h },
      // (a level of rooms and caves: the cells the shell owns are not the rock's, gen/solidMass.ts)
      rock: (x, y) => inLevelState(x, y) === CELL.SOLID && (shell?.rockMayTake(x, y) ?? true),
      open: (x, y) => V.cell(x, y).open,
      floorTop: (x, y) => topOf(V.cell(x, y)),
      toeOk: (x, y) => {
        const c = V.cell(x, y);
        return (
          c.floor &&
          (c.flags & (CELL_FLAG.PATH | CELL_FLAG.LINK | CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR)) === 0 &&
          !taken.has(`${x},${y}`) &&
          !edgeBlocked.has(`${x},${y}`)
        );
      },
      shapes,
      ceiling,
      // generator 4: solid rock, filled from the foot with no see-through gap
      ...(profile.solidCaveRock ? { solid: true } : {}),
    });
    for (const f of faces) if (!plan.columns.has(`${f.x},${f.y}`)) columnLater.delete(`${f.x},${f.y}`);
    for (const pc of plan.pieces) {
      const q = vars[pc.shape];
      if (!q) continue;
      const deg = (((frame.planDegreesToWorld(pc.rot) + q.rot) % 360) + 360) % 360;
      const c = frame.point(pc.cx, pc.cy);
      const off = rotateXZ(q.geom.boundsCenter.x, q.geom.boundsCenter.z, deg * frame.o.rotSense);
      emit(q, pc.family === "toe" ? "feature" : "wall", c.x - off.x, pc.base, c.z - off.z, deg, {
        cell: [Math.floor(pc.cx), Math.floor(pc.cy)],
        elementId: pc.family === "toe" ? "cave_foot" : pc.family === "cap" ? "cave_cap" : "cave_mass",
      });
      // a tile (corner-origin) piece turned off the quarter turns: its box is the turned outline's (the box of a
      // corner-origin piece is only right for quarter turns)
      const last = placements[placements.length - 1];
      if (last && q.geom.originAt === "minCorner")
        rebox(
          last,
          placementBox(
            { ...q.geom, originAt: "other" },
            last.x,
            last.y,
            last.z,
            last.rot * orientation.rotSense,
          ),
        );
    }
  }
}

/** Cells the mass's foot stones keep clear of ("x,y"): within 2 of an opening or stair edge, within 1 of a feature. */
function massKeepClear(lv: RealizeLevel): { edgeBlocked: Set<string>; taken: Set<string> } {
  const { L, V } = lv;
  const edgeBlocked = new Set<string>();
  for (const orient of ["h", "v"] as const) {
    const g = V.edges(orient);
    for (let y = L.bounds.y; y <= L.bounds.y + V.h; y++)
      for (let x = L.bounds.x; x <= L.bounds.x + V.w; x++) {
        const e = orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y);
        if (e < 0 || (g.kind[e] !== EDGE.OPENING && g.kind[e] !== EDGE.STAIR)) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) edgeBlocked.add(`${x + dx},${y + dy}`);
      }
  }
  const taken = new Set<string>();
  for (const f of L.features)
    for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
      for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++)
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) taken.add(`${x + dx},${y + dy}`);
  return { edgeBlocked, taken };
}

/** The pieces a theme builds its rock mass from (`vars[shape.id]` is each shape's variant). */
function massShapes(lv: RealizeLevel, theme: ThemeId): { vars: ResolvedVariant[]; shapes: WallShape[] } {
  const { L } = lv;
  const { lookup } = lv.ctx;
  const vars: ResolvedVariant[] = [];
  const shapes: WallShape[] = [];
  const add = (
    roleName: string,
    family: WallShape["family"],
    ok: (q: ResolvedVariant) => boolean,
    lift?: (q: ResolvedVariant) => number,
  ): void => {
    const r = lookup(L.id, theme, [roleName], undefined, true);
    for (const q of r?.variants ?? []) {
      if (q.weight <= 0 || !ok(q)) continue;
      shapes.push({
        id: vars.length,
        family,
        w: q.geom.size.x,
        d: q.geom.size.z,
        h: q.geom.size.y,
        weight: q.weight,
        ...(lift === undefined ? {} : { lift: lift(q) }),
      });
      vars.push(q);
    }
  };
  // one rock family per cave: the Cavern kit (cliff.cave_mass), the tone of the wall columns; themes without it build
  // the mass from their own cliff band rock (crest boulders and faces)
  add("cliff.cave_mass", "A", () => true);
  const kit = shapes.length > 0;
  if (!kit) {
    add("cliff.formation_crest", "A", (q) => q.geom.size.y >= 1.2);
    add("cliff.formation_face", "A", () => true);
  }
  // flat sheets close the far part of a deep band
  if (kit) add("cliff.cave_cap", "cap", () => true);
  // foot stones: the kit's low stone, else small rocks and rubble
  if (kit)
    add(
      "cliff.cave_mass",
      "toe",
      (q) => q.geom.size.y <= 1.05,
      () => 0,
    );
  else {
    add(
      "feature.rock",
      "toe",
      (q) => q.geom.size.y <= 0.8 && q.geom.size.x >= 0.9,
      () => 0,
    );
    add(
      "feature.rubble",
      "toe",
      (q) => q.geom.size.y <= 0.8 && q.geom.size.x >= 0.8,
      () => 0,
    );
  }
  return { vars, shapes };
}
