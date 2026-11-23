/**
 * Realize, what a building carries on its walls: chimneys, porches, the lights by its doors and in its windows,
 * entrance strips and a shopfront's sign band.
 *   chimney    chimney.<style> → chimney.default;  pot chimney_top.<style> → chimney_top.default
 *   porch      roof.<kit>.flat → floor.<porch floor>;  posts porch_post.<style> → porch_post.default → feature.pillar
 *   door light wall_light.<style> → wall_light.default → feature.torch_wall
 *   lit window light.window.<style> → light.window → feature.candles (glow: light.glow.<colour> → light.glow →
 *              feature.crystal)
 *   strips     light.strip;  sign band sign_band.<style> → feature.signage → sign_band.default
 * A storey with no walls takes each part's row of resolve/building/parts.ts OPEN_STOREY_WALLS.
 * Reads: the structure, the level's openings, the windows the courses built. Writes: wall, post and feature placements.
 */
import { SIDE_STEP } from "../../../gen/gridGeometry";
import { isWindow, openingTests } from "../../../gen/openingKinds";
import { ONE_CELL } from "../../../palette/filters";
import type { ResolvedVariant } from "../../../palette/resolve";
import {
  THEME_POST_ROLE,
  defaultPartRole,
  featureRole,
  floorRole,
  lightRole,
  partRole,
  postRole,
  roofRole,
} from "../../../palette/roles";
import { partWalls } from "../../../resolve/building/parts";
import { rotateXZ } from "../../geometry";
import { h32Utf16 } from "../../../util/hash";
import { EPS } from "../level";
import { groundTop, legiblyWorn, unit01, type StructureCtx } from "./context";
import type { LitWindow } from "./courses";
import { openingFace } from "./openings";
import { layTiles, placeProp, setOf, wallProp } from "./pieces";
import { maxOf, minOf } from "../../../util/lists";

/** (chimneyScale) The shortest face a chimney breast's three-wide foot stands on. */
const BREAST_FACE = 9;

/** Chimneys: a breast of blocks in the wall line, from the ground past the main roof, a pot on top. */
export function layChimneys(b: StructureCtx, roofTop: number): void {
  const { st, lv } = b;
  const { L, emit } = lv;
  const { frame, pick } = lv.ctx;
  for (const c of st.chimneys) {
    const s0 = st.storeys[0];
    const fs = partWalls(s0?.footing?.style ?? s0?.walls, "chimney");
    const r = b.lookup([partRole("chimney", fs), defaultPartRole("chimney")], ONE_CELL, false);
    const v = r ? pick(r.variants, `${L.id}:${st.id}:chimney`) : undefined;
    if (!v) continue;
    const m = frame.rectMin(c.at[0], c.at[1], 1, 1);
    const lo = Math.min(s0?.floorTop ?? 0, groundTop(lv, c.at[0], c.at[1]));
    // generator 3: the stack tops out about a tile and a half above the ridge, pot included (it was two and a half), and
    // the foot is three wide for its first two courses (a breast, not a pole)
    // (the profile's `roofValleys` switch, carried on the building as ResolvedStructure.valleys)
    const chimneyBreast = st.valleys === true;
    const hi = roofTop + (chimneyBreast ? 0.5 : 1.5);
    const n = Math.max(1, Math.ceil((hi - lo) / v.unitHeight - EPS));
    const source = { cell: [c.at[0], c.at[1]] as [number, number], elementId: `${st.id}~chimney` };
    // generator 5 (`chimneyScale`): the three-wide foot only on a face of BREAST_FACE cells or more (a third of it at
    // most); a smaller house has one stack
    const faceLength = (): number => {
      const along = c.side === "N" || c.side === "S" ? 0 : 1;
      const line = c.side === "N" || c.side === "S" ? 1 : 0;
      const on = st.cells.filter((q) => q[line] === c.at[line]).map((q) => q[along]);
      return on.length === 0 ? 0 : maxOf(on) - minOf(on) + 1;
    };
    if (chimneyBreast && (!lv.ctx.profile.chimneyScale || faceLength() >= BREAST_FACE)) {
      const [dx, dy] = SIDE_STEP[c.side];
      const lat: Array<[number, number]> = [
        [c.at[0] + Math.abs(dy), c.at[1] + Math.abs(dx)],
        [c.at[0] - Math.abs(dy), c.at[1] - Math.abs(dx)],
      ];
      for (const [lx, ly] of lat) {
        if (st.cells.some(([x, y]) => x === lx && y === ly)) continue;
        const ml = frame.rectMin(lx, ly, 1, 1);
        const lowL = Math.min(s0?.floorTop ?? 0, groundTop(lv, lx, ly));
        for (let k = 0; k < Math.min(2, n); k++)
          emit(
            v,
            "wall",
            ml.x,
            lowL + k * v.unitHeight,
            ml.z,
            v.rot,
            { cell: [lx, ly], elementId: `${st.id}~chimney` },
            "storey:0",
          );
      }
    }
    for (let k = 0; k < n; k++) emit(v, "wall", m.x, lo + k * v.unitHeight, m.z, v.rot, source, "storey:0");
    const pr = b.lookup([partRole("chimney_top", fs), defaultPartRole("chimney_top")], undefined, true);
    const pv = pr ? pick(pr.variants, `${L.id}:${st.id}:pot`) : undefined;
    if (pv) emit(pv, "wall", m.x, lo + n * v.unitHeight, m.z, pv.rot, source, "storey:0");
  }
}

/** Porches: posts at the outer corners, a flat roof below the eave. */
export function layPorches(b: StructureCtx): void {
  const { st, lv } = b;
  const { L, emit } = lv;
  const { frame, pick } = lv.ctx;
  const s0 = st.storeys[0];
  if (!s0) return;
  const kit = st.roof.style;
  const groundWallTop = s0.floorTop + s0.wallHeight;
  for (const [pi, p] of st.porches.entries()) {
    if (!p.roof) continue;
    const xs = p.cells.map((c) => c[0]);
    const ys = p.cells.map((c) => c[1]);
    const x0 = minOf(xs);
    const x1 = maxOf(xs) + 1;
    const y0 = minOf(ys);
    const y1 = maxOf(ys) + 1;
    const roofY = Math.max(s0.floorTop + 2, groundWallTop - 1);
    // generator 3: an attached porch takes the building's condition: a ruin's hood has fallen (one post stands), a
    // weathered one has lost a third of its roof cells
    const worn = legiblyWorn(b);
    const gone = worn && st.condition === "ruined";
    const roofCells = gone
      ? []
      : worn
        ? p.cells.filter((_, i) => p.cells.length < 2 || h32Utf16(`${st.id}:porch${pi}:${i}`) % 3 !== 0)
        : p.cells;
    // generator 5 (porchWear): a sagging porch's outer row sits one step lower (the building's own eave never sags)
    const sag = b.lv.ctx.profile.porchWear ? (p.sag ?? 0) : 0;
    const outerRow = (c: readonly [number, number]): boolean =>
      p.side === "S"
        ? c[1] === y1 - 1
        : p.side === "N"
          ? c[1] === y0
          : p.side === "E"
            ? c[0] === x1 - 1
            : c[0] === x0;
    const rows: Array<[ReadonlyArray<readonly [number, number]>, number]> =
      sag > 0
        ? [
            [roofCells.filter((c) => !outerRow(c)), roofY],
            [roofCells.filter((c) => outerRow(c)), roofY - sag],
          ]
        : [[roofCells, roofY]];
    for (const [rc, y] of rows)
      if (rc.length > 0)
        layTiles(b, [roofRole(kit, "flat"), floorRole(p.floor)], setOf(rc), y, "wall", {
          id: `${st.id}~porchroof${pi}`,
          layer: "roof",
        });
    const style = partWalls(s0.walls, "porch");
    const pr = b.lookup(
      [partRole("porch_post", style), defaultPartRole("porch_post"), featureRole("pillar")],
      undefined,
      false,
    );
    const pv0 = pr ? pick(pr.variants, `${L.id}:${st.id}:porchpost`) : undefined;
    if (!pv0) continue;
    const outer: Array<[number, number]> =
      p.side === "S"
        ? [
            [x0 + 0.15, y1 - 0.15],
            [x1 - 0.15, y1 - 0.15],
          ]
        : p.side === "N"
          ? [
              [x0 + 0.15, y0 + 0.15],
              [x1 - 0.15, y0 + 0.15],
            ]
          : p.side === "E"
            ? [
                [x1 - 0.15, y0 + 0.15],
                [x1 - 0.15, y1 - 0.15],
              ]
            : [
                [x0 + 0.15, y0 + 0.15],
                [x0 + 0.15, y1 - 0.15],
              ];
    // generator 5 (porchWear): a post replaced with what was to hand, another kind of post on the second corner
    const other =
      b.lv.ctx.profile.porchWear && p.posts === "mixed"
        ? otherPost(b, style, pv0, `${L.id}:${st.id}:porchpost2`)
        : null;
    for (const [i, [px, py]] of (gone ? outer.slice(0, 1) : outer).entries()) {
      const c = frame.point(px, py);
      const pv = i === 1 && other ? other : pv0;
      const off =
        pv.geom.originAt === "minCorner"
          ? { x: pv.geom.size.x / 2, z: pv.geom.size.z / 2 }
          : rotateXZ(pv.geom.boundsCenter.x, pv.geom.boundsCenter.z, 0);
      // (the outer posts stand under the sagged row)
      const n = Math.max(1, Math.round((roofY - sag - s0.floorTop) / Math.max(0.25, pv.unitHeight)));
      for (let k = 0; k < n; k++)
        emit(
          pv,
          "wall_post",
          c.x - off.x,
          s0.floorTop + k * pv.unitHeight,
          c.z - off.z,
          pv.rot,
          { cell: [Math.floor(px), Math.floor(py)], elementId: `${st.id}~porch${pi}` },
          "storey:0",
        );
    }
  }
}

/**
 * Generator 5 (porchWear): a post of another kind than `pv` for a mixed porch: another variant of the porch post
 * chain, else the theme's own wall post or pillar; null when the theme has none.
 */
function otherPost(b: StructureCtx, style: string, pv: ResolvedVariant, key: string): ResolvedVariant | null {
  for (const roles of [
    [partRole("porch_post", style), defaultPartRole("porch_post"), featureRole("pillar")],
    [postRole(style), THEME_POST_ROLE],
    [featureRole("pillar")],
  ]) {
    const r = b.lookup(roles, undefined, true);
    const others = (r?.variants ?? []).filter(
      (v) => v.weight > 0 && v.uuid !== pv.uuid && v.geom.size.y >= 0.5,
    );
    const v = others.length > 0 ? b.lv.ctx.pick(others, key) : undefined;
    if (v) return v;
  }
  return null;
}

/** A light on the wall beside each door. */
export function layDoorLights(b: StructureCtx): void {
  const { st } = b;
  const { L } = b.lv;
  const s0 = st.storeys[0];
  if (!s0) return;
  for (const lt of st.lights) {
    const style = partWalls(s0.walls, "doorLight");
    const r = b.lookup(
      [partRole("wall_light", style), defaultPartRole("wall_light"), featureRole("torch_wall")],
      undefined,
      true,
    );
    const v = r ? b.lv.ctx.pick(r.variants, `${L.id}:${st.id}:light:${lt.at[0]},${lt.at[1]}`) : undefined;
    if (!v || !r) continue;
    // centre 0.65 cells out from the edge line (0.15 outside the wall's outer face), 1.6 tiles up
    wallProp(b, v, r.role, { x: lt.at[0], y: lt.at[1], face: lt.side }, 1.15, s0.floorTop + 1.6, {
      id: `${st.id}~light`,
      layer: "storey:0",
    });
  }
}

/** Lit windows: a warm room light or a coloured glow on the floor just inside a seeded share of the windows. */
export function layWindowLights(b: StructureCtx, windows: readonly LitWindow[]): void {
  const { st, lv } = b;
  const lit = st.lighting;
  if (!lit || lit.windows === "none" || lit.lit <= 0) return;
  // generator 5 (buildingRooms): a ground storey split into rooms is lit by its rooms (gen/rooms4), not from its windows
  const groundTop = st.storeys[0]?.floorTop;
  const roomsLit = lv.L.areas.some((a) => a.building === st.id);
  for (const w of windows) {
    if (roomsLit && w.floorTop === groundTop) continue;
    const roles =
      lit.windows === "glow"
        ? [lightRole("glow", lit.colour), lightRole("glow"), featureRole("crystal")]
        : [lightRole("window", w.walls), lightRole("window"), featureRole("candles")];
    const r = b.lookup(roles, undefined, true);
    if (!r) continue;
    const k = `${st.id}:lit:${w.x},${w.y},${w.face},${w.floorTop}`;
    if (unit01(lv, k) >= lit.lit) continue;
    const v = lv.ctx.pick(r.variants, `${lv.L.id}:${k}`);
    if (!v) continue;
    // in the middle of the cell behind the window (clear of the wall, seen through the glass)
    placeProp(b, v, w.x + 0.5, w.y + 0.5, w.floorTop, (h32Utf16(k) % 4) * 90, {
      id: `${st.id}~lit`,
      layer: w.layer,
    });
  }
}

/** Entrance strips: a pair of light strips flanking the main door (the one on the street face first). */
export function layEntranceStrips(b: StructureCtx): void {
  const { st, lv } = b;
  const s0 = st.storeys[0];
  if (!st.lighting?.strips || !s0) return;
  const doors = lv.L.openings.filter((o) => st.openingIds.includes(o.id) && !isWindow(o.kind));
  const op = doors.find((o) => openingFace(st, o).face === st.frontage?.side) ?? doors[0];
  if (!op) return;
  const r = b.lookup([lightRole("strip")], undefined, true);
  if (!r) return;
  const { c, face } = openingFace(st, op);
  for (const along of [-0.55, op.width - 0.45]) {
    const v = lv.ctx.pick(r.variants, `${lv.L.id}:${st.id}:strip:${along}`);
    if (v)
      wallProp(
        b,
        v,
        r.role,
        { x: c[0], y: c[1], face },
        1.05,
        s0.floorTop + 0.25,
        { id: `${st.id}~strip`, layer: "storey:0" },
        along,
      );
  }
}

/** Shopfront: a sign band over each wide window of the ground storey's street face. */
export function layShopfront(b: StructureCtx): void {
  const { st, lv } = b;
  const s0 = st.storeys[0];
  const fr = st.frontage;
  if (!fr?.shopfront || !s0) return;
  const r = b.lookup(
    [
      partRole("sign_band", partWalls(s0.walls, "signBand")),
      featureRole("signage"),
      defaultPartRole("sign_band"),
    ],
    undefined,
    true,
  );
  if (!r) return;
  const top = s0.floorTop + (s0.footing?.height ?? 0) + 2;
  const windowed = openingTests(lv.ctx.profile).window;
  for (const op of lv.L.openings) {
    if (!st.openingIds.includes(op.id) || !windowed(op.kind)) continue;
    const { c, face } = openingFace(st, op);
    if (face !== fr.side) continue;
    const v = lv.ctx.pick(r.variants, `${lv.L.id}:${op.id}:sign`);
    if (v)
      wallProp(
        b,
        v,
        r.role,
        { x: c[0], y: c[1], face },
        1.05,
        top + (st.design?.details.includes("canopy") ? 0.8 : 0.15), // above a canopy
        { id: `${st.id}~sign`, layer: "storey:0" },
        (op.width - 1) / 2,
      );
  }
}
