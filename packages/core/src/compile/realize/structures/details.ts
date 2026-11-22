/**
 * Realize, a designed building's facade details (its design's `details`): corner piers, a canopy or awning over the
 * street front, balconies at the front windows above the ground, a fire escape on a side face, banners or a balcony
 * ring on a tower's shaft, vines on the base, and service pipes and units on the back (so backs are not blank). Faces
 * against another building get none; a ruin keeps only its vines.
 *   piers      corner_pier.<style> → corner_pier.default
 *   canopy     canopy.<style> → canopy.default → the flat kit's flat roof → a tile floor (awning: canopy.awning)
 *   balconies  balcony.default → the flat kit's flat roof → a tile floor;  rail balcony_rail.default
 *   others     fire_escape.default, feature.banner_wall, ruin_growth.default, wall_pipe.default, wall_unit.default;
 *              a balcony ring floor.<material> → a stone floor, railed wall.railing_stone → wall.railing
 * Reads: the design, the volumes, the cells of other buildings. Writes: post, floor, wall and feature placements.
 */
import type { Side } from "../../../contracts/plan";
import type { ResolvedVolume } from "../../../contracts/resolved";
import { OPPOSITE, SIDE_STEP } from "../../../gen/gridGeometry";
import { openingTests } from "../../../gen/openingKinds";
import {
  BALCONY_RING_RAIL_ROLES,
  defaultPartRole,
  featureRole,
  floorRole,
  partRole,
  roofRole,
} from "../../../palette/roles";
import { PART_FALLBACK_FLOORS, PART_FALLBACK_KITS, partWalls } from "../../../resolve/building/parts";
import { h32Utf16 } from "../../../util/hash";
import { EPS } from "../level";
import { groundTop, type StructureCtx } from "./context";
import { openingFace } from "./openings";
import {
  cellOfKey,
  faceCells,
  faceKey,
  faceRunsOf,
  key,
  layTiles,
  placeProp,
  setOf,
  stackEdge,
  wallProp,
  type FaceCell,
} from "./pieces";

/** The flat piece a canopy and a balcony borrow, then the floor they fall back to. */
const BORROWED_FLAT = [roofRole(PART_FALLBACK_KITS.flat, "flat"), floorRole(PART_FALLBACK_FLOORS.tile)];

export function layDetails(
  b: StructureCtx,
  vols: readonly ResolvedVolume[],
  foreign: ReadonlySet<string>,
): void {
  const { st, lv } = b;
  const { L, emit } = lv;
  const { frame, pick, profile } = lv.ctx;
  const d = st.design;
  const s0 = st.storeys[0];
  if (!d || d.details.length === 0 || !s0) return;
  const front = st.frontage?.side ?? "S";
  const cells = setOf(st.cells);
  const walls = partWalls(s0.walls, "details");
  const free = (f: FaceCell): boolean => {
    const [dx, dy] = SIDE_STEP[f.face];
    return !foreign.has(key(f.x + dx, f.y + dy));
  };
  const faces = faceCells(cells).filter(free);
  /** Highest wall top over a ground cell (its volume's tallest storey that still covers it). */
  const topAt = (x: number, y: number): number => {
    let t = s0.floorTop + s0.wallHeight;
    for (const v of vols)
      for (const sp of v.storeys)
        if (sp.cells.some((c) => c[0] === x && c[1] === y)) t = Math.max(t, sp.wallTop);
    return t;
  };
  const tag = (k: string): string => `${st.id}~${k}`;
  // a ruin keeps only what grows on it: balconies, banners, turrets and services fell with the rest
  for (const detail of st.condition === "ruined" ? d.details.filter((x) => x === "vines") : d.details) {
    if (detail === "piers") {
      const r = b.lookup([partRole("corner_pier", walls), defaultPartRole("corner_pier")], undefined, true);
      const v = r ? pick(r.variants, `${L.id}:${st.id}:pier`) : undefined;
      if (!v) continue;
      for (const k of cells) {
        const [cx, cy] = cellOfKey(k);
        for (const [dx, dy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const) {
          if (cells.has(key(cx + dx, cy)) || cells.has(key(cx, cy + dy)) || cells.has(key(cx + dx, cy + dy)))
            continue;
          if (foreign.has(key(cx + dx, cy)) || foreign.has(key(cx, cy + dy))) continue;
          // centred on the corner of the two wall lines, standing proud of both faces
          const px = (dx < 0 ? cx - 0.25 : cx + 1.25) - 0.5;
          const py = (dy < 0 ? cy - 0.25 : cy + 1.25) - 0.5;
          const m = frame.rectMin(px, py, 1, 1);
          const lo = Math.min(s0.floorTop, groundTop(lv, cx + dx, cy + dy));
          const hi = topAt(cx, cy);
          const n = Math.max(1, Math.ceil((hi - lo) / v.unitHeight - EPS));
          for (let j = 0; j < n; j++)
            emit(
              v,
              "wall_post",
              m.x,
              hi - (n - j) * v.unitHeight,
              m.z,
              v.rot,
              { cell: [cx + dx, cy + dy], elementId: tag("pier") },
              "storey:0",
            );
        }
      }
    } else if (detail === "canopy" || detail === "awning") {
      // a slab two cells deep over the street front, above the doors and shop windows (generator 3 cottages: an
      // awning of tent-cloth roof pieces, one cell deep, over the whole front)
      const awning = detail === "awning";
      const run = faces.filter((f) => f.face === front);
      const [dx, dy] = SIDE_STEP[front];
      const along = (f: FaceCell): number => (front === "N" || front === "S" ? f.x : f.y);
      const lo = Math.min(...run.map(along));
      const hi = Math.max(...run.map(along));
      const slab = new Set<string>();
      for (const f of run) {
        if (!awning && (along(f) === lo || along(f) === hi)) continue;
        for (const k of awning ? [1] : [1, 2]) {
          const c = key(f.x + dx * k, f.y + dy * k);
          if (!cells.has(c) && !foreign.has(c)) slab.add(c);
        }
      }
      const y = s0.floorTop + (awning ? 2 : (s0.footing?.height ?? 0) + 2.25);
      layTiles(
        b,
        awning
          ? [partRole("canopy", "awning")]
          : [partRole("canopy", walls), defaultPartRole("canopy"), ...BORROWED_FLAT],
        slab,
        y,
        "floor",
        { id: tag("canopy"), layer: "storey:0" },
      );
    } else if (detail === "balconies") {
      const [dx, dy] = SIDE_STEP[front];
      const windowed = openingTests(profile).window;
      for (const u of st.upperOpenings) {
        if (u.side !== front || !windowed(u.kind)) continue;
        const v = vols.find((vv) => vv.id === u.volume) ?? vols[0];
        const sp = v?.storeys[u.storey];
        if (!sp) continue;
        const part = { id: tag("balcony"), layer: `storey:${u.storey}` };
        for (let k = 0; k < u.width; k++) {
          const fx = front === "N" || front === "S" ? u.at[0] + k : u.at[0];
          const fy = front === "N" || front === "S" ? u.at[1] : u.at[1] + k;
          const c = key(fx + dx, fy + dy);
          if (foreign.has(c)) continue;
          layTiles(
            b,
            [defaultPartRole("balcony"), ...BORROWED_FLAT],
            new Set([c]),
            sp.floorTop - 0.5,
            "floor",
            part,
          );
          stackEdge(
            b,
            [defaultPartRole("balcony_rail")],
            "wall",
            { x: fx + dx, y: fy + dy, face: front },
            sp.floorTop,
            sp.floorTop + 1,
            part,
          );
        }
      }
    } else if (detail === "fire_escape") {
      const r = b.lookup([defaultPartRole("fire_escape")], undefined, true);
      const v = r ? pick(r.variants, `${L.id}:${st.id}:fire`) : undefined;
      if (!v || !r) continue;
      const sides: Side[] = front === "N" || front === "S" ? ["E", "W"] : ["N", "S"];
      let best: FaceCell[] = [];
      for (const side of sides)
        for (const run of faceRunsOf(faces.filter((f) => f.face === side)))
          if (run.length > best.length) best = run;
      if (best.length < 3) continue;
      const m = best[Math.floor(best.length / 2)] as FaceCell;
      const [dx, dy] = SIDE_STEP[m.face];
      // three cells along, three out (the unit and a cell of air): clear of every other building and its wall ring
      let clear = true;
      for (let a = -1; a <= 1 && clear; a++)
        for (let o = 1; o <= 3 && clear; o++) {
          const x = m.x + dx * o + (dx === 0 ? a : 0);
          const y = m.y + dy * o + (dy === 0 ? a : 0);
          for (let ey = -1; ey <= 1 && clear; ey++)
            for (let ex = -1; ex <= 1 && clear; ex++) if (foreign.has(key(x + ex, y + ey))) clear = false;
          if (cells.has(key(x, y))) clear = false;
        }
      if (!clear) continue;
      // the unit's long axis (x, three cells) runs along the face, its two cells of depth out from the wall
      // (which of the two long sides faces the wall is UNVERIFIED in game)
      const deg = m.face === "N" ? 0 : m.face === "S" ? 180 : m.face === "E" ? 90 : 270;
      const main =
        vols.find((vv) => vv.storeys[0]?.cells.some((c) => c[0] === m.x && c[1] === m.y)) ?? vols[0];
      for (const [s, sp] of (main?.storeys ?? []).entries()) {
        if (s === 0 || !sp.cells.some((c) => c[0] === m.x && c[1] === m.y)) continue;
        placeProp(
          b,
          v,
          m.x + 0.5 + dx * 2.1,
          m.y + 0.5 + dy * 2.1,
          sp.floorTop - 0.5,
          deg,
          { id: tag("fire_escape"), layer: `storey:${s}` },
          "wall",
        );
      }
    } else if (detail === "banners" || detail === "balcony") {
      // on the main shaft: banners on the front face two thirds up; a balcony ring round a storey there
      const stack = vols.filter((v) => v.id !== "turret" && v.id !== "crown");
      const shaft = stack[Math.max(1, Math.round(stack.length * 0.6))] ?? stack[stack.length - 1];
      const sp = shaft?.storeys[0];
      if (!shaft || !sp) continue;
      const own = setOf(sp.cells);
      if (detail === "banners") {
        const r = b.lookup([featureRole("banner_wall")], undefined, true);
        const run = faceRunsOf(faceCells(own).filter((ff) => ff.face === front))[0];
        if (!r || !run || run.length < 3) continue;
        for (const ff of [run[0], run[run.length - 1]] as FaceCell[]) {
          const v = pick(r.variants, `${L.id}:${st.id}:banner:${ff.x},${ff.y}`);
          if (v)
            wallProp(b, v, r.role, { x: ff.x, y: ff.y, face: front }, 1.05, sp.floorTop + 0.5, {
              id: tag("banner"),
              layer: "storey:0",
            });
        }
      } else {
        // a ring of floor a cell wide outside the walls, a railing on its outer edge
        const ring = new Set<string>();
        for (const k of own) {
          const [x, y] = cellOfKey(k);
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
          ] as const)
            if (!own.has(key(x + dx, y + dy)) && !foreign.has(key(x + dx, y + dy)))
              ring.add(key(x + dx, y + dy));
        }
        const part = { id: tag("balcony"), layer: "storey:0" };
        layTiles(
          b,
          [floorRole(sp.floor), floorRole(PART_FALLBACK_FLOORS.stone)],
          ring,
          sp.floorTop - 0.5,
          "floor",
          part,
        );
        for (const ff of faceCells(new Set([...own, ...ring])))
          if (ring.has(key(ff.x, ff.y)))
            stackEdge(b, BALCONY_RING_RAIL_ROLES, "wall", ff, sp.floorTop, sp.floorTop + 1, part);
      }
    } else if (detail === "vines") {
      // growth climbing the base on two faces
      const r = b.lookup([defaultPartRole("ruin_growth")], undefined, true);
      if (!r) continue;
      // never in front of a doorway: its cell and the cells beside it stay clear
      const doorCells = new Set<string>();
      const doorway = openingTests(profile).doorway;
      for (const op of L.openings) {
        if (!st.openingIds.includes(op.id) || !doorway(op.kind)) continue;
        const { c, face } = openingFace(st, op);
        const along = face === "N" || face === "S" ? [1, 0] : [0, 1];
        for (let k = -1; k <= op.width; k++)
          doorCells.add(faceKey(c[0] + (along[0] ?? 0) * k, c[1] + (along[1] ?? 0) * k, face));
      }
      for (const ff of faces) {
        if (doorCells.has(faceKey(ff.x, ff.y, ff.face))) continue;
        if (h32Utf16(`${st.id}:vine:${ff.x},${ff.y}${ff.face}`) % 4 !== 0) continue;
        const v = pick(r.variants, `${L.id}:${st.id}:vine:${ff.x},${ff.y}`);
        const [dx, dy] = SIDE_STEP[ff.face];
        if (v)
          placeProp(
            b,
            v,
            ff.x + 0.5 + dx * 2,
            ff.y + 0.5 + dy * 2,
            groundTop(lv, ff.x + dx * 2, ff.y + dy * 2),
            0,
            { id: tag("vines") },
          );
      }
    } else if (detail === "services") {
      const back = OPPOSITE[front];
      const run = faceRunsOf(faces.filter((f) => f.face === back)).sort((p, q) => q.length - p.length)[0];
      if (!run || run.length < 2) continue;
      const pr = b.lookup([defaultPartRole("wall_pipe")], undefined, true);
      const pv = pr ? pick(pr.variants, `${L.id}:${st.id}:pipe`) : undefined;
      if (pv && pr)
        for (const f of [run[0], run[run.length - 1]] as FaceCell[]) {
          const hi = topAt(f.x, f.y);
          for (let yy = s0.floorTop; yy + pv.geom.size.y <= hi + 0.3; yy += pv.geom.size.y)
            wallProp(
              b,
              pv,
              pr.role,
              { x: f.x, y: f.y, face: back },
              1.15,
              yy,
              { id: tag("pipe"), layer: "storey:0" },
              0,
            );
        }
      const ur = b.lookup([defaultPartRole("wall_unit")], undefined, true);
      const uv = ur ? pick(ur.variants, `${L.id}:${st.id}:unit`) : undefined;
      const mid = run[Math.floor(run.length / 2)];
      if (uv && ur && mid)
        wallProp(
          b,
          uv,
          ur.role,
          { x: mid.x, y: mid.y, face: back },
          1.0 + uv.geom.size.z / 2,
          s0.floorTop + 0.1,
          { id: tag("unit"), layer: "storey:0" },
        );
    }
  }
}
