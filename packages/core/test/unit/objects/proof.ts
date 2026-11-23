/**
 * The object-recipe proof (dev only): one plain wood_town floor at generator 5 with a rowing boat, a river barge and a
 * brig side by side, bows north, and a market stall beside them, each built by its recipe and placed whole. The
 * resolved plan is hand-made (no plan word asks for objects yet); objects.test.ts checks it builds clean and a
 * git-ignored script compiles it to the slab the owner pastes. Original designs only.
 */
import type { PaletteCatalog } from "../../../src/contracts/compiler";
import type { ResolvedPlan } from "../../../src/contracts/resolved";
import {
  buildObject,
  createKit,
  placeObject,
  stall,
  vessel,
  type BuiltObject,
  type ObjectKit,
  type PlacedObject,
} from "../../../src/objects";
import { createPlanRoles } from "../../../src/palette/planRoles";
import { handLevel, handPlan } from "../compile/handResolved";

export const OBJECT_PROOF_SIZE = { w: 46, h: 46 } as const;
/** The floor top of the hand level (elevation 0, floor 0.5 thick): every object's datum. */
export const FLOOR_TOP = 0.5;

export interface ProofObject {
  readonly id: string;
  readonly see: string;
  readonly at: readonly [number, number];
  readonly turn: number;
  readonly built: BuiltObject;
  readonly placed: PlacedObject;
}

/** The kit the proof builds with (wood_town, generator 5). */
export function proofKit(palettes: PaletteCatalog): ObjectKit {
  return createKit(createPlanRoles(palettes, 5), "wood_town");
}

/** The proof's objects, built and placed. */
export function proofObjects(palettes: PaletteCatalog): { objects: ProofObject[]; kit: ObjectKit } {
  const kit = proofKit(palettes);
  const row = 27;
  const specs = [
    {
      id: "obj-boat",
      at: [5, row] as const,
      see: "a rowing boat 6 long: planked hull to a stem post, transom stern, bottom boards, two thwarts, two oars",
      built: buildObject(vessel, { size: 6, seed: "proof-boat" }, kit),
    },
    {
      id: "obj-barge",
      at: [14, row] as const,
      see: "a river barge 14 long: blunt bow, square stern, flat deck, cargo, a short mast with a furled yard, a sweep",
      built: buildObject(vessel, { size: 14, seed: "proof-barge" }, kit),
    },
    {
      id: "obj-brig",
      at: [28, row] as const,
      see: "a brig 30 long: fine bow, raised forecastle and quarterdeck, two tall masts with three yards each, topsails set, ratlines, bowsprit, ship's boat",
      built: buildObject(vessel, { size: 30, seed: "proof-brig" }, kit),
    },
    {
      id: "obj-stall",
      at: [40, row] as const,
      see: "a market stall 3 wide: counter, four posts, wares, canopy, sign, stock, side cloths, stool",
      built: buildObject(stall, { size: 3, seed: "proof-stall", budget: 100 }, kit),
    },
  ];
  const objects = specs.map((s): ProofObject => {
    const placed = placeObject(s.built, { id: s.id, anchor: { at: s.at, base: FLOOR_TOP, turn: 0 } });
    return { ...s, turn: placed.turn, placed };
  });
  return { objects, kit };
}

/** The proof's resolved plan: the plain floor with every object's instances on it. */
export function objectsProof(palettes: PaletteCatalog): {
  resolved: ResolvedPlan;
  objects: ProofObject[];
  kit: ObjectKit;
} {
  const { objects, kit } = proofObjects(palettes);
  const rows = Array.from({ length: OBJECT_PROOF_SIZE.h }, () => ".".repeat(OBJECT_PROOF_SIZE.w));
  const level = handLevel({ id: "proof", rows, theme: "wood_town" });
  level.arrangements = objects.flatMap((o) => o.placed.instances);
  return { resolved: { ...handPlan([level]), planId: "object-recipes", generator: 5 }, objects, kit };
}
