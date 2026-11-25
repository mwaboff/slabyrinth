/**
 * The gun platform recipe (generator 5): a square timber deck raised on corner posts, a railing round its edge and a
 * gun on each side. A second object built by the same part-level rules as the vessel, with no path of its own:
 *   - a deck covers its body's whole outline at its level (objects/deck.ts `floorOver`, checked by `openDeckCells`);
 *   - a mounted gun's muzzle faces out from the body's centre (objects/facing.ts `yawFacing`, checked by
 *     `facingFaults`), read from the piece's own front, whatever the kit.
 * Built facing +z (its front, the way it would travel or face), centred on the origin, its posts on the floor.
 */
import type { Placed, XZ } from "../arrange/piece";
import { floorOver } from "./deck";
import { yawFacing } from "./facing";
import { maxOf } from "../util/lists";
import { at, columnTo, part, type Draft, type ObjectParams, type ObjectRecipe, type Part } from "./recipe";

export type PlatformParams = ObjectParams;

/** How high the platform's deck stands (its top). */
const DECK = 2.5;

export const platform: ObjectRecipe<PlatformParams> = {
  id: "platform",
  doc: "a gun platform: a square deck on corner posts, a railing round it, a gun facing out on each side",
  slots: {
    mass: { doc: "the deck, over the whole body" },
    supports: { doc: "corner posts" },
    face: { doc: "the railing round the deck" },
    top: { doc: "a gun on each side, muzzle out" },
  },
  budget: 120,
  lods: 1,
  build(params, kit): Draft {
    const h = Math.max(2, Math.round(params.size / 2));
    const outline: XZ[] = [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ];
    const parts: Part[] = [];
    // (the kit's own forms, if its data prefers one: objects/kit.ts OBJECT_KITS; this recipe names no kit)
    const tiles = { small: "deckSmall", big: "deck" } as const;
    parts.push(part("deck", "mass", floorOver(outline, DECK, kit, `${String(params.seed)}:deck`, tiles)));
    // corner posts from the ground to the deck's underside, whole pieces that fit (never below the ground)
    const candidates = [...kit.mix("corner"), ...kit.mix("post")];
    const column = columnTo(candidates, DECK - 0.5);
    if (column.length > 0) {
      const inset = maxOf(column.map((c) => c.piece.measures.length)) / 2;
      const posts: Placed[] = [];
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const)
        for (const c of column) posts.push(at(c.piece, sx * (h - inset), c.y, sz * (h - inset)));
      parts.push(part("posts", "supports", posts));
    }
    const rail = kit.piece("rail");
    if (rail) {
      const len = rail.measures.length;
      const pieces: Placed[] = [];
      const edge = h - 0.15;
      for (let s = -h + len / 2; s <= h - len / 2 + 1e-6; s += len) {
        const lengthYaw = rail.measures.runAxis === "z" ? 90 : 0;
        pieces.push(at(rail, s, DECK, -edge, lengthYaw), at(rail, s, DECK, edge, lengthYaw));
        pieces.push(at(rail, -edge, DECK, s, lengthYaw + 90), at(rail, edge, DECK, s, lengthYaw + 90));
      }
      parts.push(part("railing", "face", pieces));
    }
    const gun = kit.piece("gun");
    if (gun) {
      const r = h - 1.2;
      const guns = (
        [
          [0, r],
          [r, 0],
          [0, -r],
          [-r, 0],
        ] as const
      ).map(([x, z]) => at(gun, x, DECK, z, yawFacing(gun, [Math.sign(x), Math.sign(z)])));
      parts.push(part("guns", "top", guns, { rung: 100, kind: "detail" }));
    }
    return {
      parts: parts.filter((p) => p.pieces.length > 0),
      footprint: outline,
      clearance: 1,
      surfaces: [{ id: "deck", y: DECK, polygon: outline }],
      spaces: [],
    };
  },
};
