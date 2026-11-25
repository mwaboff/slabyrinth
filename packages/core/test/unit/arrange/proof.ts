/**
 * The engine-operators proof (dev only): one plain generic floor at generator 5 with one arrangement instance per
 * operator, side by side, made from the generic palette's trait pools. `engineOperatorsProof` returns the resolved plan
 * (hand-made: no resolve stage attaches instances yet); proof.test.ts checks it builds clean, and a git-ignored script
 * compiles it to the slab the owner pastes. Original designs only.
 */
import {
  arcPath,
  array,
  extent,
  fan,
  fromPool,
  layer,
  lengthwise,
  pick,
  polyline,
  repeat,
  rest,
  ring,
  roundCount,
  run,
  scatter,
  single,
  sink,
  stack,
  station,
  toInstance,
  transform,
  twin,
  vary,
  HAND_BUILT,
  type ArrangePiece,
  type Arrangement,
} from "../../../src/arrange";
import type { PaletteCatalog } from "../../../src/contracts/compiler";
import type { ResolvedArrangement, ResolvedPlan } from "../../../src/contracts/resolved";
import { createPlanRoles } from "../../../src/palette/planRoles";
import { pickFromPool, type TraitQuery } from "../../../src/palette/traitPools";
import { handLevel, handPlan } from "../compile/handResolved";

/** One demonstration: what the owner should see, where (the plan cell its anchor is the middle of), the arrangement. */
export interface ProofStation {
  readonly id: string;
  readonly operator: string;
  readonly at: readonly [number, number];
  readonly see: string;
  readonly arrangement: Arrangement;
}

export const PROOF_SIZE = { w: 44, h: 24 } as const;
/** The floor top of the hand level (elevation 0, floor 0.5 thick). */
const FLOOR_TOP = 0.5;

/**
 * The pieces the proof borrows from the generic palette, by shape: from each trait pool the piece whose name is the
 * one the proof was written for (so the owner sees a plain timber, crate or rock), else the pool's hash pick.
 */
export function proofPieces(palettes: PaletteCatalog) {
  const roles = createPlanRoles(palettes, 5);
  const take = (key: string, prefer: string, q: TraitQuery): ArrangePiece => {
    const pool = roles.pool("generic", q);
    const p =
      pool.pieces.find((x) => x.variant.name === prefer) ?? pickFromPool(pool, "engine-operators-proof", key);
    if (!p) throw new Error(`the generic palette has no piece for ${key}`);
    return fromPool(pool, p);
  };
  return {
    post: take("post", "castle pillar", {
      trait: "post",
      kind: "prop",
      where: { height: [1.5, 3], length: [0.3, 0.8], spread: [1, 1.1] },
    }),
    board: take("board", "support beam 2x2 pillar", {
      trait: "post",
      kind: "prop",
      where: { height: [1.2, 3], width: [0.03, 0.3], length: [0.2, 0.6] },
    }),
    beam: take("beam", "Harbor Beam 03", { trait: "beam", kind: "prop", where: { length: [1, 2.5] } }),
    banner: take("banner", "banner_01", { trait: "panel", kind: "prop", where: { length: [1, 2.2] } }),
    wall: take("wall", "Stone Wall 01", { trait: "panel", kind: "prop", where: { length: [1, 2.2] } }),
    block: take("block", "Crate - Large", { trait: "block", kind: "prop", where: { height: [0.75, 1.1] } }),
    stone: take("stone", "Rock - Small", { trait: "clutter", kind: "prop", where: { extent: [0.25, 0.6] } }),
    cup: take("cup", "jug 01", { trait: "clutter", kind: "prop", where: { extent: [0.1, 0.4] } }),
    flat: take("flat", "Desert Cliff04 pile", { trait: "slab", kind: "prop", where: { length: [0.4, 1.5] } }),
  };
}

/** The demonstrations, one per operator, laid out in three rows. */
export function proofStations(palettes: PaletteCatalog): ProofStation[] {
  const P = proofPieces(palettes);
  const st = (id: string, operator: string, at: [number, number], see: string, arrangement: Arrangement) => ({
    id: `op-${id}`,
    operator,
    at,
    see,
    arrangement,
  });
  const beamRun = lengthwise(P.beam);
  const lattice = array(beamRun, { axis: "z", count: 5, pitch: 3 * extent(beamRun, "z") });
  const boards = array(lengthwise(P.board), { axis: "x", count: 6 });
  const walls = array(lengthwise(P.wall), { axis: "x", count: 2 });
  const kit = [...single(P.post), ...transform(single(P.stone), { dx: 0.7 })];
  return [
    // row 1
    st(
      "fan",
      "fan",
      [4, 4],
      "left: the plain square post; right: the same post fanned in 15° steps into a round column",
      [
        ...transform(single(P.post), { dx: -1.5 }),
        ...transform(fan(single(P.post), { count: roundCount(single(P.post)) }), { dx: 1 }),
      ],
    ),
    st(
      "array",
      "array",
      [12, 4],
      "a boarded panel: six thin boards side by side, each one board-width from the last",
      boards,
    ),
    st(
      "mesh",
      "array (crossed)",
      [20, 4],
      "a mesh: five beams one way, five turned a quarter and laid across them",
      [...lattice, ...transform(lattice, { turn: 90, dy: extent(beamRun, "y") })],
    ),
    st(
      "run-corner",
      "run",
      [27, 3],
      "beams end to end round a right-angle corner, a post plugging each joint and end",
      run(beamRun, {
        path: polyline([
          [0, 0],
          [4, 0],
          [4, -3],
        ]),
        overlap: 0.05,
        filler: single(P.post),
        fillEnds: true,
      }),
    ),
    st(
      "run-arc",
      "run (arc)",
      [35, 6],
      "beams along a quarter circle of radius 4, each turned 15° from the last",
      run(beamRun, {
        path: arcPath({ radius: 4, from: 270, sweep: 90 }),
        overlap: 0.05,
      }),
    ),
    // row 2
    st(
      "twin",
      "twin",
      [4, 12],
      "a one-sided banner and its copy turned 180° just behind it: a banner with two faces",
      twin(single(P.banner), {
        offset: [0, extent(single(P.banner), "z")],
      }),
    ),
    st("ring", "ring", [12, 12], "eight stones round a block, each turned to face the middle", [
      ...single(P.block),
      ...ring(single(P.stone), { count: 8, radius: 1.3, facing: "centre" }),
    ]),
    st(
      "scatter",
      "scatter",
      [20, 12],
      "flat pieces and stones strewn over 4 x 4, clumped, overlapping, at any turn",
      scatter([...single(P.flat), ...single(P.stone)], {
        area: { w: 4, d: 4 },
        density: 3,
        cluster: 0.6,
        clusterSize: 2,
        edgeBias: 0.2,
        minSpacing: 0.15,
        empty: 0.2,
        seed: "proof",
      }),
    ),
    st(
      "rest",
      "rest",
      [28, 12],
      "a block on a block, and three cups resting on the top one",
      rest(
        transform(array(single(P.cup), { axis: "x", count: 3, gap: 0.05 }), { dz: 0.1 }),
        rest(transform(single(P.block), {}), single(P.block)),
        { each: true },
      ),
    ),
    st(
      "sink",
      "sink",
      [36, 12],
      "a block sunk 40% into the floor, a stone sunk 30% into its top",
      (() => {
        const block = sink(single(P.block), { fraction: 0.4 });
        const onTop = rest(single(P.stone), block).slice(block.length);
        return [...block, ...sink(onTop, { fraction: 0.3 })];
      })(),
    ),
    // row 3
    st("stack", "stack", [4, 20], "three blocks stacked in courses", stack(single(P.block), { count: 3 })),
    st(
      "layer",
      "layer",
      [12, 20],
      "two low walls end to end, and a second skin of the same walls 0.05 north of them, shifted half a wall",
      layer(walls, {
        normal: "z",
        proud: 0.05,
        shift: extent(lengthwise(P.wall), "x") / 2,
      }),
    ),
    st(
      "station",
      "station + mirror",
      [19, 20],
      "a post-and-stone kit every 2 tiles along 8 tiles, mirrored on the far side",
      station(kit, {
        path: polyline([
          [0, 0],
          [8, 0],
        ]),
        every: 2,
        offset: 1,
        mirrored: true,
      }),
    ),
    st(
      "fence",
      "repeat + pick + vary",
      [31, 20],
      "a slat fence filling 6 tiles: thin slats with one or two heavy pillars among them (the odd ones), slats visibly uneven (heights within 0.12, set within 0.08, a 15° turn now and then), a slat missing here and there",
      vary(
        pick(
          repeat(lengthwise(P.board), {
            axis: "x",
            pitch: 0.95 * extent(lengthwise(P.board), "x"),
            length: 6,
          }),
          {
            from: [P.board, P.post],
            policy: { kind: "odd", rate: 0.1 },
            seed: "proof",
          },
        ),
        { seed: "proof", ...HAND_BUILT, empty: 0.1 },
      ),
    ),
  ];
}

/** The proof's resolved plan: the plain floor with every station's instance on it. */
export function engineOperatorsProof(palettes: PaletteCatalog): {
  resolved: ResolvedPlan;
  stations: ProofStation[];
} {
  const stations = proofStations(palettes);
  const rows = Array.from({ length: PROOF_SIZE.h }, () => ".".repeat(PROOF_SIZE.w));
  const level = handLevel({ id: "proof", rows, theme: "generic" });
  level.arrangements = stations.map((s): ResolvedArrangement =>
    // anchored at the middle of the station's cell
    toInstance(s.arrangement, {
      id: s.id,
      recipe: s.operator,
      anchor: { at: [s.at[0] + 0.5, s.at[1] + 0.5], base: FLOOR_TOP },
    }),
  );
  return { resolved: { ...handPlan([level]), planId: "engine-operators", generator: 5 }, stations };
}
