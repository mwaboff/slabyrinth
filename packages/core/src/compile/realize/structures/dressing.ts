/**
 * Realize, the dressing of a weathered or ruined building (the resolver chose where; generator 3 for the legible
 * condition): debris at its foot, broken blocks and rubble on its cut wall tops, growth climbing it, and what a ruin
 * keeps of its battlements. A theme without a role gets nothing: never a wrong object.
 *   debris     ruin_rubble.default (a timber building's ruin_rubble.<style>), ruin_prop.default, ruin_growth.default
 *   wall tops  ruin_block.<style> → ruin_block.default;  ruin_rubble.default (timber: the style's own roles only)
 *   growth     ruin_climber.default → feature.vines;  ruin_root.default → feature.roots_wall;
 *              ruin_cap.default → ruin_growth.default;  ruin_tree.default → feature.tree
 *   remnants   crenel.<style> → crenel.default
 * Reads: the structure's debris, ruin and growth records. Writes: feature and wall placements.
 */
import { SIDE_STEP } from "../../../gen/gridGeometry";
import { isPlankWallStyle } from "../../../gen/wallStyles";
import {
  SMALL_PLANT,
  SMALL_TREE,
  VINE_BATCH,
  VINE_STRAND,
  WALL_ROOT,
  lenFilter,
} from "../../../palette/filters";
import type { ResolvedVariant } from "../../../palette/resolve";
import { RUIN_CLIMBER_ROLE, defaultPartRole, featureRole, partRole } from "../../../palette/roles";
import { buildingWalls, partWalls } from "../../../resolve/building/parts";
import { h32Utf16, hashUnitUtf16 } from "../../../util/hash";
import { groundTop, legiblyWorn, type StructureCtx } from "./context";
import { edgePiece, faceKey, placeProp, wallProp } from "./pieces";

/** Rubble and growth at the foot of a weathered or ruined building. */
export function layDebris(b: StructureCtx): void {
  const { st, lv } = b;
  for (const d of st.debris ?? []) {
    const walls = buildingWalls(st);
    const timber = legiblyWorn(b) && isPlankWallStyle(walls);
    // (generator 3: fallen stone does not lie beside a timber building; its own material or nothing)
    const role =
      d.kind === "rubble"
        ? timber && walls
          ? partRole("ruin_rubble", walls)
          : defaultPartRole("ruin_rubble")
        : d.kind === "prop"
          ? defaultPartRole("ruin_prop")
          : defaultPartRole("ruin_growth");
    const r = b.lookup([role], undefined, true);
    const k = `${st.id}:debris:${d.at[0]},${d.at[1]}`;
    // a heap wider than a cell and a half would lean into the walls beside it: smaller pieces when the role has them
    const small = r ? r.variants.filter((x) => Math.max(x.geom.size.x, x.geom.size.z) <= 1.6) : [];
    const v = r ? lv.ctx.pick(small.length ? small : r.variants, `${lv.L.id}:${k}`) : undefined;
    if (v)
      placeProp(
        b,
        v,
        d.at[0] + 0.5,
        d.at[1] + 0.5,
        groundTop(lv, d.at[0], d.at[1]),
        // generator 3: heaps lie at their own angles, not square to the grid
        legiblyWorn(b) ? (h32Utf16(k) % 24) * 15 : (h32Utf16(k) % 4) * 90,
        { id: `${st.id}~${d.kind}` },
      );
  }
}

/**
 * Broken blocks and small rubble lying on the cut tops of a ruin's walls (generator 3; the resolver chose the
 * columns). Pieces no wider than a wall are preferred, set on the wall's strip at the cut height.
 */
export function layWallTopRubble(b: StructureCtx): void {
  const { st, lv } = b;
  const list = st.ruin?.topRubble;
  if (!list || list.length === 0) return;
  const style = partWalls(buildingWalls(st), "ruin");
  // never a neat whole block seated square on a step (the pale 1x1 stair block read as coping stones in game): wall-top
  // material is broken stuff, rubble heaps of mixed sizes (a long pile now and then) and block pieces only when the
  // role has small broken ones (a brick pile), each turned at its own angle along the wall
  // timber walls (generator 3): what lies on a timber wall is timber (fallen beams, planks): the wall material's own
  // role, and nothing when the palette has none, never grey stone blocks on brown planks
  const timber = legiblyWorn(b) && isPlankWallStyle(style);
  const blockRole = b.lookup(
    timber ? [partRole("ruin_block", style)] : [partRole("ruin_block", style), defaultPartRole("ruin_block")],
    undefined,
    true,
  );
  const heapRole = b.lookup(
    timber ? [partRole("ruin_rubble", style)] : [defaultPartRole("ruin_rubble")],
    undefined,
    true,
  );
  const longest = (x: ResolvedVariant): number => Math.max(x.geom.size.x, x.geom.size.z);
  const smallBroken = [
    ...(heapRole?.variants.filter((x) => longest(x) <= 1.1) ?? []),
    ...(blockRole?.variants.filter((x) => longest(x) <= 0.8) ?? []),
  ];
  // a long pile only across three neighbouring rubble columns of one wall (it never reaches over an opening)
  const longPile = heapRole?.variants.filter((x) => longest(x) > 1.1 && longest(x) <= 1.7) ?? [];
  const listed = new Set(list.map((t) => faceKey(t.at[0], t.at[1], t.side)));
  if (smallBroken.length === 0) return;
  const legibleCondition = legiblyWorn(b);
  for (const t of list) {
    const k = `${st.id}:walltop:${t.at[0]},${t.at[1]}${t.side}`;
    const [ax, ay] = t.side === "N" || t.side === "S" ? [1, 0] : [0, 1];
    const spans =
      legibleCondition &&
      longPile.length > 0 &&
      listed.has(faceKey(t.at[0] - ax, t.at[1] - ay, t.side)) &&
      listed.has(faceKey(t.at[0] + ax, t.at[1] + ay, t.side)) &&
      h32Utf16(`${k}:long`) % 2 === 0;
    const v = lv.ctx.pick(spans ? longPile : smallBroken, `${lv.L.id}:${k}`);
    if (!v) continue;
    const [dx, dy] = SIDE_STEP[t.side];
    const jit = (s: string): number => hashUnitUtf16(lv.ctx.seed, k, s) - 0.5;
    // along the wall (a long pile lies lengthwise), 15 degree steps of yaw either side, never square to the step
    const base = (t.side === "N" || t.side === "S" ? 0 : 90) + (h32Utf16(`${k}:flip`) % 2) * 180;
    const yaw = legibleCondition ? base + Math.round(jit("yaw") * 6) * 15 : (h32Utf16(k) % 4) * 90;
    const [ux, uy] = t.side === "N" || t.side === "S" ? [1, 0] : [0, 1];
    placeProp(
      b,
      v,
      t.at[0] +
        0.5 +
        dx * (0.75 + (legibleCondition ? jit("out") * 0.2 : 0)) +
        (legibleCondition ? ux * jit("al") * 0.3 : 0), // the wall strip lies in the ring cell outside the face (edge pieces are hosted there)
      t.at[1] +
        0.5 +
        dy * (0.75 + (legibleCondition ? jit("out") * 0.2 : 0)) +
        (legibleCondition ? uy * jit("al") * 0.3 : 0),
      t.top,
      ((yaw % 360) + 360) % 360,
      { id: `${st.id}~walltop`, layer: "roof" },
      "wall", // a piece of the broken wall itself: the prop checks (floating over floor) do not apply to masonry
    );
  }
}

/**
 * Growth that climbs the structure (generator 3; the resolver chose where, `ResolvedStructure.growth`): vine strands
 * stacked up a wall face, roots at its base, small growth on a cut wall top, a tree in a roofless middle. Pieces no
 * wider than a cell and a half sit on the wall face.
 */
export function layGrowth(b: StructureCtx): void {
  const { st, lv } = b;
  const { L } = lv;
  const { seed, pick } = lv.ctx;
  const list = st.growth;
  if (!list || list.length === 0) return;
  const climber = b.lookup([RUIN_CLIMBER_ROLE, featureRole("vines")], VINE_STRAND, true);
  // the largest climbing piece the palette has: a broad batch (a face and a half wide) for the foot of a heavy mass
  const batcher = b.lookup([RUIN_CLIMBER_ROLE, featureRole("vines")], VINE_BATCH, true);
  const rooter = b.lookup([defaultPartRole("ruin_root"), featureRole("roots_wall")], WALL_ROOT, true);
  const capper = b.lookup([defaultPartRole("ruin_cap"), defaultPartRole("ruin_growth")], SMALL_PLANT, true);
  const treer = b.lookup([defaultPartRole("ruin_tree"), featureRole("tree")], SMALL_TREE, true);
  for (const g of list) {
    const k = `${st.id}:grow:${g.kind}:${g.at[0]},${g.at[1]}${g.side ?? ""}`;
    const rnd = (s: string): number => hashUnitUtf16(seed, k, s);
    if ((g.kind === "vine" || g.kind === "root") && g.side) {
      const r = g.kind === "vine" ? climber : rooter;
      if (!r) continue;
      const part = { id: `${st.id}~${g.kind === "vine" ? "vine" : "wallroot"}`, layer: "storey:0" };
      let y = g.from;
      const thick = g.thick ?? 1;
      for (let i = 0; i < 8 && y < g.to - 0.3; i++) {
        // a broad batch over the lowest course of a wide mass (it spans this face and its neighbours)
        const wideV =
          g.wide && i === 0 && g.kind === "vine" && batcher
            ? pick(batcher.variants, `${L.id}:${k}:wide`)
            : undefined;
        // strands side by side, one fewer at each course up (masses thin upward)
        const n = wideV ? 1 : Math.max(1, thick - i);
        let adv = 0;
        for (let j = 0; j < n; j++) {
          // a strand that fits the span (a little over at most)
          const fit = r.variants.filter((v) => v.geom.size.y <= g.to - y + 0.4);
          const v = wideV ?? pick(fit.length ? fit : r.variants, `${L.id}:${k}:${i}:${j}`);
          if (!v) break;
          const h = v.geom.size.y;
          if (h > g.to - y + 0.5) break;
          const base = Math.max(g.from, Math.min(y, g.to - h));
          const along =
            n === 1 ? (rnd(`a${i}`) - 0.5) * 0.5 : (j - (n - 1) / 2) * 0.34 + (rnd(`a${i}:${j}`) - 0.5) * 0.1;
          wallProp(b, v, r.role, { x: g.at[0], y: g.at[1], face: g.side }, 1.15, base, part, along);
          adv = Math.max(adv, base + h * 0.9);
        }
        if (adv === 0) break;
        y = adv;
      }
    } else if (g.kind === "cap" && g.side && capper) {
      const v = pick(capper.variants, `${L.id}:${k}`);
      if (!v) continue;
      const [dx, dy] = SIDE_STEP[g.side];
      placeProp(
        b,
        v,
        g.at[0] + 0.5 + dx * 0.75,
        g.at[1] + 0.5 + dy * 0.75,
        g.from,
        (h32Utf16(k) % 4) * 90,
        { id: `${st.id}~topgrowth`, layer: "roof" },
        "wall",
      );
    } else if (g.kind === "tree" && treer) {
      const v = pick(treer.variants, `${L.id}:${k}`);
      if (!v) continue;
      placeProp(b, v, g.at[0] + 0.5, g.at[1] + 0.5, groundTop(lv, g.at[0], g.at[1]), (h32Utf16(k) % 4) * 90, {
        id: `${st.id}~tree`,
      });
    }
  }
}

/**
 * What a ruin keeps of its battlements (the reference keep: crenellation pieces at whatever height the wall now
 * ends, not one parapet line): a crenel piece on some columns that stand above both neighbours. Only where the
 * wall style has crenels; otherwise nothing.
 */
export function layRuinFragments(b: StructureCtx): void {
  const { st, lv } = b;
  if (st.condition !== "ruined" || !st.ruin) return;
  const at = new Map(st.ruin.columns.map((c) => [faceKey(c.at[0], c.at[1], c.side), c]));
  const style = partWalls(buildingWalls(st), "ruin");
  const r = b.lookup([partRole("crenel", style), defaultPartRole("crenel")], lenFilter(1), true);
  if (!r) return;
  for (const c of st.ruin.columns) {
    if (c.top >= c.full - 1e-6) continue; // an intact top carries its roof or parapet as built
    const [ax, ay] = c.side === "N" || c.side === "S" ? [1, 0] : [0, 1];
    const p = at.get(faceKey(c.at[0] - ax, c.at[1] - ay, c.side));
    const q = at.get(faceKey(c.at[0] + ax, c.at[1] + ay, c.side));
    if (!p || !q || p.top >= c.top || q.top >= c.top) continue;
    const k = `${st.id}:remnant:${c.at[0]},${c.at[1]}${c.side}`;
    if (h32Utf16(`${lv.ctx.seed}:${k}`) % 3 !== 0) continue;
    const v = lv.ctx.pick(r.variants, `${lv.L.id}:${k}`);
    if (v)
      edgePiece(b, v, "wall", { x: c.at[0], y: c.at[1], face: c.side }, 1, c.top, {
        id: `${st.id}~remnant`,
        layer: "roof",
      });
  }
}
