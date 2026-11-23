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
import { kitOr } from "./kit";
import { at, part, type Draft, type ObjectParams, type ObjectRecipe, type Part } from "./recipe";

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
    const tiles = { small: kitOr(kit, "shipDeckSmall", "deckSmall"), big: kitOr(kit, "shipDeck", "deck") };
    parts.push(part("deck", "mass", floorOver(outline, DECK, kit, `${String(params.seed)}:deck`, tiles)));
    const post = kit.piece("corner") ?? kit.piece("post");
    if (post) {
      const posts: Placed[] = [];
      const ph = post.variant.geom.size.y;
      const top = DECK - 0.5;
      const inset = post.measures.length / 2;
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const)
        for (let y = 0; y < top - 0.05; y += ph)
          posts.push(at(post, sx * (h - inset), Math.min(y, top - ph), sz * (h - inset)));
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
    const gun = kit.piece(kitOr(kit, "shipCannon", "barrel"));
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
