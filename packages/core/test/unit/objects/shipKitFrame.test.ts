/**
 * The vessel recipe's ship-kit turns (objects/vessel.ts SHIP_KIT_FRAME) held to the geometry measured from the game's
 * own meshes (objects/shipKitGeometry.ts): every hull tile and the curved bow fence at the measured turn for a
 * bow-north ship, "L" halves on the port side, port and starboard pieces mirror turns of one another, and a built hull's
 * pieces at exactly those turns. No game needed: the measured numbers are data.
 */
import { describe, expect, it } from "vitest";
import {
  buildObject,
  createKit,
  objectTurn,
  piecesOf,
  SHIP_KIT_FRAME as F,
  vessel,
} from "../../../src/objects";
import { pieceFacts } from "../../../src/gen/pieceFacts";
import { turned } from "../../../src/objects/facing";
import { MEASURED_BOW_FENCE, MEASURED_HULL, MEASURED_PROPS } from "../../../src/objects/shipKitGeometry";
import { loadPalettes } from "../../../src/palette";
import { createPlanRoles } from "../../../src/palette/planRoles";

/** A recipe yaw (bow +x) as TaleSpire steps for a bow-north ship. */
const steps = (recipeYaw: number): number => ((((recipeYaw - 90) % 360) + 360) % 360) / 15;
const measured = (piece: string, side: string): number | undefined =>
  MEASURED_HULL.find((s) => s.piece === piece && s.side === side)?.steps;

describe("SHIP_KIT_FRAME agrees with the measured kit", () => {
  it("turns the hull sides 6 (port) and 18 (starboard) for a bow-north ship", () => {
    expect(steps(F.sidePortYaw)).toBe(measured("Ship bottom side 4x2_Port and Starboard", "port"));
    expect(steps(F.sidePortYaw + 180)).toBe(measured("Ship bottom side 4x2_Port and Starboard", "starboard"));
  });

  it("puts L on the port side and turns every half 12", () => {
    expect(F.leftSide).toBe(1);
    for (const p of ["Ship bottom front L_Bow", "Ship bottom back L_Stern"])
      expect(steps(F.halfYaw), p).toBe(measured(p, "port"));
    for (const p of ["Ship bottom front R_Bow", "Ship bottom back R_Stern"])
      expect(steps(F.halfYaw), p).toBe(measured(p, "starboard"));
  });

  it("turns the curved bow fence 12 (port) and 18 (starboard)", () => {
    expect(steps(F.bowFenceYaw)).toBe(MEASURED_BOW_FENCE.port);
    expect(steps(F.bowFenceYaw + F.bowRailStarboardTurn)).toBe(MEASURED_BOW_FENCE.starboard);
  });

  it("holds the piece facts the builds read to the mesh measurements (cannon, helm, gallery)", () => {
    // the facts (gen/pieceFacts.ts) are what realize and the object engine turn by; the measurements are the record
    for (const n of ["ship cannon static", "ship cannon up or down"])
      expect(pieceFacts(n).front?.axis, n).toBe(MEASURED_PROPS.cannonBarrel);
    expect(pieceFacts("Ship floor Steering wheel").front?.axis).toBe(MEASURED_PROPS.helmOperator);
    for (const n of [
      "Ship wall 2x2 decor window unique",
      "Ship wall 2x2 decor corner unique L",
      "Ship wall 2x2 decor corner unique R",
    ])
      expect(pieceFacts(n).wallDepth, n).toBe(MEASURED_PROPS.galleryWallDepth);
    // the gallery's outer face, turned by the kit's bow yaw, faces the stern (-x in the recipe's frame)
    const AXIS: Readonly<Record<string, readonly [number, number]>> = { "+z": [0, 1], "-z": [0, -1] };
    const face = AXIS[MEASURED_PROPS.galleryFace] ?? [0, 0];
    const out = turned(face, F.bowYaw);
    expect(out[0]).toBeCloseTo(-1);
    expect(out[1]).toBeCloseTo(0);
  });

  it("measured the chosen turns clearly better than the next best", () => {
    for (const s of MEASURED_HULL)
      if (s.nextBest !== undefined) expect(s.seam, s.piece).toBeLessThan(s.nextBest);
    expect(MEASURED_BOW_FENCE.seam).toBeLessThan(MEASURED_BOW_FENCE.nextBest);
  });
});

describe("a built hull uses exactly those turns", () => {
  const kit = createKit(createPlanRoles(loadPalettes(), 5), "wood_town");
  const o = buildObject(vessel, { size: 24, seed: "frame", kind: "ship" }, kit);
  // the built object's frame is bow +z (north): a piece's yaw there is its bow-north turn
  const at = (name: string): number[] =>
    [
      ...new Set(
        piecesOf(o)
          .filter((q) => q.piece.variant.name === name)
          .map((q) => (((q.yaw % 360) + 360) % 360) / 15),
      ),
    ].sort((a, b) => a - b);

  it("turns its hull tiles and bow fences as measured, port and starboard mirror turns", () => {
    expect(objectTurn(o, 0)).toBe(0);
    expect(at("Ship bottom side 4x2_Port and Starboard")).toEqual([6, 18]);
    for (const p of [
      "Ship bottom front L_Bow",
      "Ship bottom front R_Bow",
      "Ship bottom back L_Stern",
      "Ship bottom back R_Stern",
    ])
      expect(at(p), p).toEqual([12]);
    expect(at("Ship fence bow curved")).toEqual([12, 18]);
  });

  it("puts the L halves on the port (west) side of a bow-north ship", () => {
    for (const [l, r] of [
      ["Ship bottom front L_Bow", "Ship bottom front R_Bow"],
      ["Ship bottom back L_Stern", "Ship bottom back R_Stern"],
    ] as const) {
      const x = (n: string): number => piecesOf(o).find((q) => q.piece.variant.name === n)?.x ?? NaN;
      expect(x(l)).toBeLessThan(x(r));
    }
  });
});
