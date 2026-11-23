/**
 * The market-stall recipe: the second object on the same mechanism, to keep it general. Front along +z (the customers'
 * side), ground at y = 0, `size` its width in tiles (2 to 4), always 2 deep.
 *
 * Slots (M12's four core slots, then the budget's additions):
 * - mass (core): the counter across the front, counter tiles (or crates when the theme has none);
 * - supports (core): four corner posts, one mismatched when the stall is worn;
 * - face (core): the wares on the counter, a run of 3 to 5 small goods between two larger ends;
 * - top (core): the canopy over the whole stall, a ridge board along its back, a sign hung off-centre at the front;
 * - rear (50): stock behind the counter, crates and barrels;
 * - skin (50): cloth hung down the two sides;
 * - seat (100): the stall-holder's stool.
 */
import { lengthwise, single, type Arrangement, type Placed, type XZ } from "../arrange/piece";
import { run } from "../arrange/along";
import { twin } from "../arrange/copies";
import { vary } from "../arrange/modifiers";
import { polyline } from "../arrange/path";
import { rest } from "../arrange/support";
import { transform } from "../arrange/transform";
import { hashUnitMixed } from "../util/hash";
import { maxOf, pushAll } from "../util/lists";
import { at, part, type Draft, type ObjectParams, type ObjectRecipe, type Part } from "./recipe";

export type StallParams = ObjectParams;

export const stall: ObjectRecipe<StallParams> = {
  id: "stall",
  doc: "a market stall: counter, four posts, wares, canopy and sign; stock, side cloths and a stool by budget",
  slots: {
    mass: { doc: "the counter" },
    supports: { doc: "four corner posts" },
    face: { doc: "the wares on the counter" },
    top: { doc: "canopy, ridge board, sign" },
    rear: { doc: "stock behind the counter" },
    skin: { doc: "side cloths" },
    seat: { doc: "the stall-holder's stool" },
  },
  budget: 50,
  lods: 1,
  build(params, kit): Draft {
    const W = Math.round(Math.min(4, Math.max(2, params.size)));
    const seed = String(params.seed);
    const condition = params.condition ?? "new";
    const hw = W / 2;
    const parts: Part[] = [];
    const cells = Array.from({ length: W }, (_, i) => -hw + i + 0.5);

    // mass: the counter across the front row
    const counterTile = kit.piece("counter");
    const counter: Placed[] = counterTile
      ? cells.map((x) => at(kit.pick("counter", seed, x) ?? counterTile, x, 0, 0.5))
      : [];
    parts.push(part("counter", "mass", counter));
    const counterTop = Math.max(0, maxOf(counter.map((q) => q.y + q.piece.variant.geom.size.y)));

    // supports: four corner posts, one of another kind when worn (mismatched repairs)
    const post = kit.piece("corner");
    if (post) {
      const odd = condition === "new" ? -1 : Math.floor(hashUnitMixed(seed, "odd post") * 4);
      const mix = kit.mix("corner");
      const corners: XZ[] = [
        [-hw + 0.25, -0.75],
        [hw - 0.25, -0.75],
        [-hw + 0.25, 0.75],
        [hw - 0.25, 0.75],
      ];
      parts.push(
        part(
          "posts",
          "supports",
          corners.map(([x, z], i) => at(i === odd ? (mix[mix.length - 1] ?? post) : post, x, 0, z)),
        ),
      );
    }
    const postTop = post ? post.variant.geom.size.y : 2;

    // face: the wares, small goods between two larger ends, resting on the counter
    const wares: Placed[] = [];
    const n = Math.min(5, Math.max(3, 2 * W - 2));
    for (let i = 0; i < n; i++) {
      const g = kit.pick("goods", seed, "ware", i);
      if (g)
        wares.push(
          at(
            g,
            -hw + 0.55 + ((W - 1.1) * (i + 0.5)) / n,
            0,
            0.45 + 0.15 * ((i % 2) - 0.5),
            360 * hashUnitMixed(seed, "turn", i),
          ),
        );
    }
    const end = kit.piece("sack") ?? kit.piece("smallCrate");
    if (end)
      for (const x of [-hw + 0.3, hw - 0.3])
        wares.push(at(end, x, 0, 0.55, 90 * Math.round(4 * hashUnitMixed(seed, "end", x))));
    const onCounter = rest(wares, counter, { each: true }).slice(counter.length);
    const shown =
      condition === "derelict"
        ? []
        : condition === "worn"
          ? vary(onCounter, { seed, empty: 0.3 })
          : onCounter;
    parts.push(part("wares", "face", shown));

    // top: canopy tiles over the stall at the posts' tops, a ridge board along the back, a sign at the front
    const canopy = kit.piece("canopy");
    const roof: Placed[] = [];
    if (canopy)
      for (const x of cells)
        for (const z of [-0.5, 0.5]) roof.push(at(kit.pick("canopy", seed, x, z) ?? canopy, x, postTop, z));
    const plank = kit.piece("plank");
    // the ridge beam under the canopy's back edge, from back post to back post, its top flush with theirs
    const ridge = plank
      ? transform(
          run(lengthwise(plank), {
            path: polyline([
              [-hw + 0.25, -0.75],
              [hw - 0.25, -0.75],
            ]),
          }),
          // a little below the posts' tops, so a lift against flicker (at most 0.08) keeps it under the canopy
          { dy: postTop - plank.variant.geom.size.y - 0.08 },
        )
      : [];
    // the sign, two-faced: a copy turned back to back behind it, so it reads from the street and from the stall
    const sign = kit.piece("sign");
    const signs: Arrangement = sign
      ? twin(
          [
            at(
              sign,
              -hw / 2,
              postTop - sign.variant.geom.size.y - 0.02,
              1.05,
              sign.measures.runAxis === "z" ? 90 : 0,
            ),
          ],
          {
            offset: [0, sign.measures.width],
          },
        )
      : [];
    const torn = condition === "derelict" ? vary(roof, { seed, empty: 0.35 }) : roof;
    parts.push(part("canopy", "top", torn));
    if (ridge.length > 0) parts.push(part("ridge beam", "top", ridge, { hold: "fastened" }));
    if (signs.length > 0) parts.push(part("sign", "top", signs, { hold: "fastened" }));

    // rear (50): stock behind the counter
    const stock: Placed[] = [];
    const crate = kit.piece("crate");
    const barrel = kit.piece("barrel");
    if (crate) pushAll(stock, transform(single(crate), { dx: -hw + 0.6, dz: -0.45 }));
    if (barrel) pushAll(stock, transform(single(barrel), { dx: hw - 0.5, dz: -0.5 }));
    if (crate && W >= 3)
      pushAll(
        stock,
        transform(rest(single(kit.piece("smallCrate") ?? crate), single(crate)), { dx: 0.1, dz: -0.45 }),
      );
    parts.push(
      part("stock", "rear", vary(stock, { seed: `${seed}:stock`, yaw: 15, along: 0.06 }), {
        rung: 50,
        kind: "detail",
      }),
    );

    // skin (50): cloth down the two sides, hung from the canopy
    const cloth = kit.piece("cloth");
    if (cloth && condition !== "derelict") {
      const ch = cloth.variant.geom.size.y;
      const side: Arrangement = transform(lengthwise(cloth), { turn: 90, dy: postTop - ch });
      parts.push(
        part(
          "side cloths",
          "skin",
          [...transform(side, { dx: -hw + 0.05 }), ...transform(side, { dx: hw - 0.05 })],
          {
            rung: 50,
            kind: "detail",
            hold: "fastened",
          },
        ),
      );
    }

    // seat (100): a stool behind the counter
    const stool = kit.piece("stool");
    if (stool)
      parts.push(part("stool", "seat", [at(stool, 0.3, 0, -0.3, 30)], { rung: 100, kind: "detail" }));

    const footprint: XZ[] = [
      [-hw, -1],
      [hw, -1],
      [hw, 1],
      [-hw, 1],
    ];
    return {
      parts: parts.filter((p) => p.pieces.length > 0),
      footprint,
      clearance: 1,
      surfaces:
        counterTop > 0
          ? [
              {
                id: "counter",
                y: counterTop,
                polygon: [
                  [-hw, 0],
                  [hw, 0],
                  [hw, 1],
                  [-hw, 1],
                ],
              },
            ]
          : [],
      spaces: [],
    };
  },
};
