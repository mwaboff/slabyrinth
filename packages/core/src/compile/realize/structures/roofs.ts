/**
 * Realize, a building's roofs: each volume's stacked roof layers on its top storey (gable wings, hips, sheds, skirts and
 * steps, spires, flat tops with their parapets), the attic deck, the gable fill under free gable ends, and dormers.
 *   roof       roof pieces of the layer's kit (roofPiece.ts; facing.front = the eave side at rot 0)
 *   deck       roof.<kit>.deck → roof.default.deck → floor.<material>
 *   gable fill gable.<style> → facade.<style> → wall.<style>
 *   parapet    parapet.<style> → wall.<style>
 * Reads: the volume, the building's chimneys, the merged valleys (generator 3). Writes: roof, deck, gable and parapet
 * placements (layer "roof"). Returns each volume's top and flat top.
 */
import type { Side, WallStyle } from "../../../contracts/plan";
import type { ResolvedStructure, ResolvedVolume } from "../../../contracts/resolved";
import { SIDE_STEP, SIDES } from "../../../gen/gridGeometry";
import { footprint, lenFilter } from "../../../palette/filters";
import { DEFAULT_PART, floorRole, partRole, roofRole, wallRole } from "../../../palette/roles";
import {
  gableRoof,
  hipRoof,
  mergeRoofs,
  type Rect,
  ringLayer,
  roofOwners,
  type RoofPiece,
  shedRoof,
} from "../../../resolve/roof";
import { isPitchedRoof } from "../../../resolve/roofTypes";
import { h32Utf16 } from "../../../util/hash";
import { exhaustive } from "../../../util/never";
import type { StructureCtx } from "./context";
import {
  cellOfKey,
  edgePiece,
  faceCells,
  faceKey,
  faceRunsOf,
  key,
  layTiles,
  rectCellsOf,
  setOf,
  stackEdge,
  type FaceCell,
} from "./pieces";
import { hasOpenBays, layRoofPiece, openBay } from "./roofPiece";
import { laySpire } from "./spire";

type VolumeStorey = ResolvedVolume["storeys"][number];

/** A flat roof top: where roof furniture (rooftop.ts) may stand. */
export interface FlatTop {
  cells: Set<string>;
  y: number;
  rect: Rect;
  /** Wall style of the storey under it and the roof kit (a roof hut is built of them). */
  walls: WallStyle | null;
  kit: string;
}

/**
 * The pitched roofs of a building (first layer of every volume: gable wings, hips, sheds) merged where they meet
 * (resolve/roof.ts mergeRoofs); keyed "<volume>#<wing>". Heights match layRoof: the wall top, plus the attic deck.
 */
export function roofValleys(
  st: ResolvedStructure,
  vols: readonly ResolvedVolume[],
): Map<string, RoofPiece[]> {
  return mergeRoofs(
    roofOwners([...vols], new Set(st.chimneys.map((c) => key(c.at[0], c.at[1]))), st.roofFill === true),
  );
}

/** The stacked roof layers of one volume; returns the top height and the flat top (for clutter and masts) if any. */
export function layRoof(
  b: StructureCtx,
  v: ResolvedVolume,
  top: VolumeStorey,
  chimneyWall: ReadonlySet<string>,
  tag: string,
  foreign: ReadonlySet<string>,
  merge: ReadonlyMap<string, RoofPiece[]> | undefined,
): { top: number; flat: FlatTop | null } {
  const { st } = b;
  const cells = setOf(top.cells);
  const wallTop = top.wallTop;
  const topStyle = top.walls;
  let base = wallTop;
  let rect: Rect = { ...top.rect };
  let roofTop = wallTop;
  let flat: FlatTop | null = null;
  const holes = new Set(st.chimneys.map((c) => key(c.at[0], c.at[1])));
  const gableFill = (fx: number, fy: number, face: Side, t: number): void => {
    const [dx, dy] = SIDE_STEP[face];
    if (!cells.has(key(fx, fy)) || cells.has(key(fx + dx, fy + dy))) return;
    if (chimneyWall.has(faceKey(fx, fy, face)) || topStyle === null) return;
    stackEdge(
      b,
      [partRole("gable", topStyle), partRole("facade", topStyle), wallRole(topStyle)],
      "wall",
      { x: fx, y: fy, face },
      wallTop,
      t,
      { id: `${tag}~gable`, layer: "roof" },
      { shortRoles: [partRole("over_door", topStyle), partRole("gable_short", topStyle)] },
    );
  };
  const n = v.roof.layers.length;
  v.roof.layers.forEach((layer, li) => {
    const kit = layer.style;
    const first = li === 0;
    const last = li === n - 1;
    const pitched = isPitchedRoof(layer.type);
    if (first && v.roof.deck && pitched) {
      layTiles(
        b,
        [roofRole(kit, "deck"), roofRole(DEFAULT_PART, "deck"), floorRole(top.floor)],
        // (generator 5: a ruin's lost bays have no deck either)
        new Set(
          [...cells].filter((k) => {
            const [x, y] = cellOfKey(k);
            return !openBay(b, { x, y, w: 1, h: 1 });
          }),
        ),
        wallTop,
        "floor",
        { id: `${tag}~deck`, layer: "roof" },
      );
      base = wallTop + 0.5;
    }
    const closeFlat = (r: Rect | null, at: number): void => {
      if (!r) return;
      const topCells = setOf(rectCellsOf(r));
      layTiles(b, [roofRole(kit, "flat"), floorRole(top.floor)], topCells, at - 0.5, "floor", {
        id: `${tag}~roof${li}`,
        layer: "roof",
      });
      flat = { cells: topCells, y: at, rect: r, walls: topStyle, kit };
    };
    switch (layer.type) {
      case "gable": {
        const wings = first ? v.rects : [{ ...rect, ridge: layer.ridge }];
        const roofs = wings.map((w) => ({ w, g: gableRoof(w, holes) }));
        // a ruin keeps the gable wall at its standing end: the slopes have fallen in
        const only = v.roof.gableOnly;
        // where wings overlap, the higher roof surface wins the cell (approximate valleys)
        const surface = (wi: number, x: number, y: number): number => {
          const r = roofs[wi];
          if (!r) return -1;
          const o = r.g.outline;
          if (x < o.x || y < o.y || x >= o.x + o.w || y >= o.y + o.h) return -1;
          const a = r.w.ridge === "ew" ? y - o.y : x - o.x;
          return r.g.rowCourse[a] ?? -1;
        };
        roofs.forEach((r, wi) => {
          let dormerNext = 1;
          // generator 3 (first layer): the pieces left after the valleys; otherwise every piece, the old rule hiding some
          const mine = first && merge ? merge.get(`${v.id}#${wi}`) : undefined;
          for (const p of mine ?? r.g.pieces) {
            let hidden = false;
            for (let y = p.y; y < p.y + p.h && !hidden && !mine; y++)
              for (let x = p.x; x < p.x + p.w && !hidden; x++)
                for (let wj = 0; wj < roofs.length; wj++) {
                  if (wj === wi) continue;
                  const own = surface(wi, x, y);
                  const other = surface(wj, x, y);
                  if (other > own || (other === own && other >= 0 && wj < wi)) hidden = true;
                }
            if (hidden || only) continue;
            // dormers at a seeded rhythm on the lowest course (kits with a dormer piece only)
            if (st.furniture?.dormers && p.kind === "slope2x2" && p.course === 0) {
              const along = r.w.ridge === "ew" ? p.x - r.g.outline.x : p.y - r.g.outline.y;
              if (along >= dormerNext && layDormer(b, kit, p, base, tag)) {
                dormerNext = along + 3 + (h32Utf16(`${b.lv.ctx.seed}:${tag}:dormer:${along}`) % 3);
                continue;
              }
            }
            layRoofPiece(b, kit, p, base, tag);
          }
          roofTop = Math.max(roofTop, base + r.g.ridgeTop);
          // gable fill under each free gable end (first layer: on the walls)
          if (!first) return;
          const w = r.w;
          const span = w.ridge === "ew" ? w.h + 2 : w.w + 2;
          const ends: Array<[Side, number]> =
            w.ridge === "ew"
              ? [
                  ["W", w.x],
                  ["E", w.x + w.w - 1],
                ]
              : [
                  ["N", w.y],
                  ["S", w.y + w.h - 1],
                ];
          for (const [face, line] of ends)
            for (let a = 1; a <= span - 2 && (!only || face === only); a++) {
              const fx = w.ridge === "ew" ? line : w.x + a - 1;
              const fy = w.ridge === "ew" ? w.y + a - 1 : line;
              gableFill(fx, fy, face, base + (r.g.rowCourse[a] ?? 0));
            }
        });
        base = roofTop;
        return;
      }
      case "hip":
      case "shed": {
        const PITCHED = {
          hip: () => hipRoof(rect, holes),
          shed: () => shedRoof(rect, layer.low, holes, st.roofFill === true),
        };
        const g = PITCHED[layer.type]();
        for (const p of (first && merge ? merge.get(`${v.id}#0`) : undefined) ?? g.pieces)
          layRoofPiece(b, kit, p, base, tag);
        if (first)
          for (const f of faceCells(cells)) {
            const [dx, dy] = SIDE_STEP[f.face];
            const s = g.surface(f.x + dx, f.y + dy);
            if (s > 0) gableFill(f.x, f.y, f.face, base + s);
          }
        roofTop = Math.max(roofTop, base + g.top);
        base = roofTop;
        return;
      }
      case "skirt":
      case "stepped": {
        const RING = { skirt: "slope", stepped: "step" } as const;
        const g = ringLayer(rect, layer.courses, RING[layer.type], first, holes);
        for (const p of g.pieces) layRoofPiece(b, kit, p, base, tag);
        base += layer.courses;
        roofTop = Math.max(roofTop, base);
        if (g.inner) rect = g.inner;
        // a flat top closes the layer unless another layer stands on it
        if (last) closeFlat(g.inner, base);
        return;
      }
      case "spire": {
        const t = laySpire(b, kit, rect, base, layer.courses, tag);
        roofTop = Math.max(roofTop, t);
        base = roofTop;
        return;
      }
      case "flat": {
        const topCells = first ? cells : setOf(rectCellsOf(rect));
        flat = layFlatTop(b, kit, topCells, rect, base, topStyle, top.floor, layer.parapet, foreign, tag);
        base += 0.5;
        roofTop = Math.max(roofTop, base);
        return;
      }
      case "none":
        return;
      default:
        exhaustive(layer.type, "roof type");
    }
  });
  return { top: roofTop, flat };
}

/**
 * A flat roof at `base` over its cells (a weathered one fallen in over a patch inside its edge; the edge and parapet
 * stand), with one course of the parapet style along each run of the roof edge, length-2 pieces where they fit.
 * Returns the flat top.
 */
function layFlatTop(
  b: StructureCtx,
  kit: string,
  topCells: Set<string>,
  rect: Rect,
  base: number,
  topStyle: WallStyle | null,
  floor: string,
  parapet: WallStyle | null,
  foreign: ReadonlySet<string>,
  tag: string,
): FlatTop {
  const { st } = b;
  const { L } = b.lv;
  const { pick } = b.lv.ctx;
  const fallen = new Set(
    (st.condition === "weathered" || hasOpenBays(b) ? (st.ruin?.roofHoles ?? []) : [])
      .map(([x, y]) => key(x, y))
      .filter((k) => {
        const [x, y] = cellOfKey(k);
        return SIDES.every((sd) => topCells.has(key(x + SIDE_STEP[sd][0], y + SIDE_STEP[sd][1])));
      }),
  );
  layTiles(
    b,
    [roofRole(kit, "flat"), floorRole(floor)],
    fallen.size ? new Set([...topCells].filter((k) => !fallen.has(k))) : topCells,
    base,
    "floor",
    { id: `${tag}~roof`, layer: "roof" },
  );
  const y = base + 0.5;
  const flat: FlatTop = {
    cells: new Set([...topCells].filter((k) => !fallen.has(k))),
    y,
    rect,
    walls: topStyle,
    kit,
  };
  if (parapet) {
    const roles = [partRole("parapet", parapet), wallRole(parapet)];
    const bitten = new Set(st.ruin?.weather?.parapetBites ?? []);
    const edge = faceCells(topCells).filter((f) => {
      const [dx, dy] = SIDE_STEP[f.face];
      return !foreign.has(key(f.x + dx, f.y + dy)) && !bitten.has(faceKey(f.x, f.y, f.face));
    });
    for (const run of faceRunsOf(edge)) {
      let i = 0;
      while (i < run.length) {
        const f = run[i] as FaceCell;
        let placed = 1;
        for (const [role, len] of roles.flatMap((ro) => [2, 1].map((l) => [ro, l] as const))) {
          if (len > run.length - i) continue;
          const r = b.lookup([role], lenFilter(len), true);
          const pv = r ? pick(r.variants, `${L.id}:${tag}:parapet:${f.x},${f.y}${f.face}`) : undefined;
          if (!pv) continue;
          edgePiece(b, pv, "wall", f, len, y, { id: `${tag}~parapet`, layer: "roof" });
          placed = len;
          break;
        }
        i += placed;
      }
    }
  }
  return flat;
}

/** A dormer piece in place of a 2×2 slope (only kits that have one: roof.<kit>.dormer). */
function layDormer(b: StructureCtx, kit: string, p: RoofPiece, base: number, tag: string): boolean {
  const { L, emit } = b.lv;
  const { frame, pick, facingOf } = b.lv.ctx;
  const r = b.lookup([roofRole(kit, "dormer")], footprint(2, 2), true);
  const v = r ? pick(r.variants, `${L.id}:${tag}:dormer:${p.x},${p.y}`) : undefined;
  if (!v || !r) return false;
  const front = facingOf(v, "roof", r.role).front ?? "N";
  const steps = frame.stepsToFace(front, frame.worldSide(p.eave));
  const m = frame.rectMin(p.x, p.y, 2, 2);
  emit(
    v,
    "wall",
    m.x,
    base + p.course,
    m.z,
    steps * 15 + v.rot,
    { cell: [p.x, p.y], elementId: `${tag}~dormer` },
    "roof",
  );
  return true;
}
