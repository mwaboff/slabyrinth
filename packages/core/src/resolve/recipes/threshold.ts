/**
 * Threshold recipes (generator 5, plan §11.2 P12, L20): the style options of a sacred or formal building, drawn by its
 * treatment (treatments.ts family "threshold": guardians, lights, both, or plain), at its main door only (the door on
 * its street face, else its first door). Both are a mirrored pair about the door's axis: the same piece each side, at
 * the same distance, turned the same way (outward).
 *
 *   guardianPair    a guardian each side of the door, 1.25-2.5 from its axis (a subject's draw), a little out from the
 *                   wall: a statue, a standing stone or the theme's own pillar.
 *   approachLights  a light each side of the approach where it meets the open ground: past the plinth and its steps
 *                   when the building stands on one, else 2-3 out from the door; beside the way, never on it.
 *
 * Pieces, theme first, then the chain (statues and lights are pieces a theme may lack and the generic palette has):
 *   guardian  feature.statue → feature.statue_large → feature.standing_stone → feature.pillar (0.8-3 tall)
 *   light     feature.torch_floor → feature.brazier → feature.lantern (standing: at most 2.5 tall)
 * No piece: the recipe is left out. A raised focal floor (P13) needs a resolve step on rooms and is not built here.
 */
import type { ArrangePiece, Placed } from "../../arrange";
import type { Side } from "../../contracts/plan";
import type { ResolvedStructure } from "../../contracts/resolved";
import { isPassage } from "../../gen/openingKinds";
import { maxOf } from "../../util/lists";
import { frameDir, framePoint, type AnchorFrame, type OpeningAnchor } from "../anchors";
import { KEEP_OFF_BESIDE_PATH, isBreach, normalSide, onGround } from "./condition";
import type { ComposeCtx, FilledSlot, Recipe, RecipeCtx } from "./types";

/** A guardian stands this far from the door's axis (a subject's draw), and this far out from the wall. */
const GUARDIAN_OFF = [1.25, 2.5] as const;
const GUARDIAN_OUT = [0.35, 0.8] as const;
/** Approach lights: out from the foot of the approach, and beside the way by this much past the door's half width. */
const LIGHT_OUT = [0.5, 1.5] as const;
const LIGHT_SIDE = [0.6, 1.1] as const;

const within = (ctx: ComposeCtx, what: string, [lo, hi]: readonly [number, number]): number =>
  lo + (hi - lo) * ctx.treatment.jitter(what);

/** The building's main door: its first door on the street face, else its first door (a passage, not a breach). */
export function mainDoor(ctx: RecipeCtx, st: ResolvedStructure): string | null {
  const ids = new Set(st.openingIds);
  const doors = ctx.level.openings.filter((o) => ids.has(o.id) && isPassage(o.kind) && !isBreach(o.id));
  const front = st.frontage?.side;
  const onFront = doors.find((o) => {
    const a = ctx.anchors.of("opening").find((q) => q.id === o.id && q.outside);
    return a !== undefined && front !== undefined && normalSide(a.frame) === front;
  });
  return (onFront ?? doors[0])?.id ?? null;
}

const isMain = (a: { structure: string | null; id: string }, ctx: RecipeCtx): boolean => {
  const st = (ctx.level.structures ?? []).find((s) => s.id === a.structure);
  return st !== undefined && mainDoor(ctx, st) === a.id;
};

/** The turn that faces a piece out of the wall (local +z): its palette front, north when it names none. */
function outward(p: ArrangePiece): number {
  const front: Side = p.variant.facing?.front ?? "N";
  return ({ N: 0, E: 270, S: 180, W: 90 } as const)[front];
}

/** Sizes a guardian and a standing light may be: [lowest, tallest] and the longest foot. */
const GUARDIAN_SIZE = { height: [0.8, 3.2], length: 1.8 } as const;
const LIGHT_SIZE = { height: [0.3, 2.6], length: 1.2 } as const;

/** The subject's piece of a slot within a size (one draw per subject: both of a pair alike). */
function choose(
  slot: FilledSlot | undefined,
  ctx: ComposeCtx,
  what: string,
  size: { height: readonly [number, number]; length: number },
): ArrangePiece | undefined {
  const ps = (slot?.pieces ?? []).filter(
    (p) =>
      p.measures.height >= size.height[0] &&
      p.measures.height <= size.height[1] &&
      p.measures.length <= size.length,
  );
  return ps[Math.floor(ctx.treatment.jitter(what) * ps.length)];
}

/** A plan point in a (quarter-turned, unmirrored) frame's local x and z. */
function toLocal(f: AnchorFrame, px: number, py: number): [number, number] {
  const [ax, ay] = framePoint(f, 0, 0);
  const [ux, uy] = frameDir(f);
  const [nx0, ny0] = framePoint(f, 0, 1);
  const [nx, ny] = [nx0 - ax, ny0 - ay];
  return [(px - ax) * ux + (py - ay) * uy, (px - ax) * nx + (py - ay) * ny];
}

/**
 * The porch in front of a door, in the door's frame: how far its cells reach from the axis and out from the wall
 * (0, 0 when the door has none). The pair stands beside it and the lights past it.
 */
function porchOf(ctx: RecipeCtx, a: OpeningAnchor): { half: number; depth: number } {
  const st = (ctx.level.structures ?? []).find((s) => s.id === a.structure);
  let half = 0;
  let depth = 0;
  for (const p of st?.porches ?? []) {
    const corners = p.cells.flatMap(([x, y]) =>
      [
        [x, y],
        [x + 1, y],
        [x, y + 1],
        [x + 1, y + 1],
      ].map(([cx = 0, cy = 0]) => toLocal(a.frame, cx, cy)),
    );
    // a porch at this door: in front of the wall, across the door's axis
    if (!corners.some(([, z]) => z > 0.01) || !corners.some(([x]) => x < 0) || !corners.some(([x]) => x > 0))
      continue;
    half = Math.max(half, maxOf(corners.map(([x]) => Math.abs(x))));
    depth = Math.max(depth, maxOf(corners.map(([, z]) => z)));
  }
  return { half, depth };
}

/**
 * The local point of the grid vertex nearest (x, z) whose distance from the axis lies in `along` and that is no nearer
 * the wall than `z` (none: (x, z) itself). A piece about a tile across stands on a cell corner, clear of every cell's
 * centre (the keep-clear rule keeps an open cell's centre free); a door's axis is a cell's centre or a grid line, so the
 * two of a pair snap alike.
 */
function vertexNear(
  f: AnchorFrame,
  x: number,
  z: number,
  along: readonly [number, number],
): [number, number] {
  const [px, py] = framePoint(f, x, z);
  let best: [number, number] = [x, z];
  let d = Infinity;
  const near = (c: number): number[] => [Math.floor(c) - 1, Math.floor(c), Math.ceil(c), Math.ceil(c) + 1];
  for (const qx of near(px))
    for (const qy of near(py)) {
      const [lx, lz] = toLocal(f, qx, qy);
      if (Math.sign(lx) !== Math.sign(x) || Math.abs(lx) < along[0] - 1e-6 || Math.abs(lx) > along[1] + 1e-6)
        continue;
      if (lz < z - 1e-6) continue;
      const dd = Math.hypot(lx - x, lz - z);
      if (dd < d) {
        d = dd;
        best = [lx, lz];
      }
    }
  return best;
}

/** A mirrored pair at about (±x, z), each on a grid vertex, or null when either side has no ground under it. */
function pair(
  ctx: ComposeCtx,
  a: { frame: AnchorFrame },
  p: ArrangePiece,
  x0: number,
  z0: number,
  along: readonly [number, number],
): Placed[] | null {
  const yaw = outward(p);
  const out: Placed[] = [];
  const [x, z] = vertexNear(a.frame, x0, z0, along);
  const [xl, zl] = vertexNear(a.frame, -x0, z0, along);
  // (mirrored: both stand as far from the axis and the wall)
  if (Math.abs(Math.abs(x) - Math.abs(xl)) > 0.01 || Math.abs(z - zl) > 0.01) return null;
  for (const sx of [x, xl]) {
    // (a pair flanks the way to the door: it may stand at the edge of a path leading there)
    const y = onGround(ctx, a.frame, sx, z, p, yaw, 0, KEEP_OFF_BESIDE_PATH);
    if (y === null) return null;
    out.push({ piece: p, x: sx, y, z, yaw });
  }
  // both on one height: a pair split across a step is no pair
  return Math.abs((out[0]?.y ?? 0) - (out[1]?.y ?? 0)) < 0.01 ? out : null;
}

/** An outside door of a building's ground storey (not a ruin's breach). */
const doorAnchor = (a: OpeningAnchor): boolean =>
  a.structure !== null && a.outside && a.storey === 0 && !isBreach(a.id);

export const guardianPair: Recipe<"opening"> = {
  id: "guardianPair",
  doc: "a mirrored guardian pair flanking a sacred or formal building's main door, 1.25-2.5 from its axis (P12)",
  switch: "guardianPair",
  family: "threshold",
  anchor: "opening",
  tier: () => 1,
  mount: "floor",
  blocking: true,
  thinnable: false,
  when: (a, ctx) => doorAnchor(a) && isPassage(a.openingKind) && isMain(a, ctx),
  slots: {
    guardian: {
      roles: () => [
        { role: "feature.statue" },
        { role: "feature.statue_large" },
        { role: "feature.standing_stone" },
        { role: "feature.pillar", own: true },
      ],
      fallback: "skip",
    },
  },
  compose: (a, slots, ctx) => {
    const p = choose(slots.guardian, ctx, "guardian", GUARDIAN_SIZE);
    if (!p) return null;
    // clear of the door's jambs and its porch, within 1.25-2.5 of its axis (a door or porch too wide for that takes
    // the nearest beyond it)
    const porch = porchOf(ctx, a);
    const least = Math.max(
      GUARDIAN_OFF[0],
      a.width / 2 + p.measures.length / 2 + 0.2,
      porch.half + p.measures.length / 2 + 0.05,
    );
    const most = Math.max(GUARDIAN_OFF[1], least + 1);
    const off = Math.max(within(ctx, "guardianOff", GUARDIAN_OFF), least);
    const z = within(ctx, "guardianOut", GUARDIAN_OUT) + p.measures.width / 2;
    return pair(ctx, a, p, off, z, [least, most]);
  },
};

export const approachLights: Recipe<"opening"> = {
  id: "approachLights",
  doc: "a mirrored light pair where a sacred or formal building's approach meets the ground, beside the way (L20)",
  switch: "approachLights",
  family: "threshold",
  anchor: "opening",
  tier: () => 1,
  mount: "floor",
  blocking: true,
  thinnable: false,
  when: (a, ctx) => doorAnchor(a) && isPassage(a.openingKind) && isMain(a, ctx),
  slots: {
    light: {
      roles: () => [
        { role: "feature.torch_floor" },
        { role: "feature.brazier" },
        { role: "feature.lantern" },
      ],
      fallback: "skip",
    },
  },
  compose: (a, slots, ctx) => {
    const p = choose(slots.light, ctx, "light", LIGHT_SIZE);
    if (!p) return null;
    const st = (ctx.level.structures ?? []).find((s) => s.id === a.structure);
    // the foot of the approach: past the porch, and past the plinth (its margin and a step per half tile of its height)
    const plinth = st?.plinth ? 1 + Math.ceil(st.plinth.height * 2) : 0;
    const z = Math.max(1, plinth, porchOf(ctx, a).depth) + within(ctx, "lightOut", LIGHT_OUT);
    const least = a.width / 2 + LIGHT_SIDE[0] + p.measures.length / 2;
    const x = a.width / 2 + within(ctx, "lightSide", LIGHT_SIDE) + p.measures.length / 2;
    return pair(ctx, a, p, x, z, [least, least + 1.5]);
  },
};
