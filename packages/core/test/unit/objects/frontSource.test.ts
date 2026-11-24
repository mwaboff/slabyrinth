/**
 * One source for a piece's front (gen/pieceFacts.ts `frontSide`): realize's facing (compile/realize/context.ts
 * `variantFacing`, which a plan feature is turned by) and the object engine (objects/facing.ts `frontOf`) agree for
 * every palette piece with a measured front, whatever the palette's own `facing` says; and no such piece is visible to
 * a frozen generator (so no released turn moved).
 */
import { describe, expect, it } from "vitest";
import { fromVariant } from "../../../src/arrange/piece";
import { variantFacing } from "../../../src/compile/realize/context";
import { frontSide } from "../../../src/gen/pieceFacts";
import { frontOf } from "../../../src/objects";
import { loadOrientation, loadPalettes } from "../../../src/palette";

const cat = loadPalettes();
const { orientation } = loadOrientation();
const SIDE = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] } as const;

describe("a piece's front has one source", () => {
  const measured = Object.entries(cat.palettes).flatMap(([pid, p]) =>
    Object.entries(p.roles).flatMap(([role, def]) =>
      def.variants.filter((v) => frontSide(v.name) !== undefined).map((v) => ({ pid, role, def, v })),
    ),
  );

  it("realize and the object engine read the same front for every piece that has one", () => {
    expect(measured.length).toBeGreaterThan(0);
    for (const { pid, role, v } of measured) {
      const side = frontSide(v.name);
      // the palette's own facing (and a contrary one) never overrides the measured front
      for (const facing of [v.facing, { front: "W" as const }, { front: "E" as const }]) {
        const f = variantFacing(
          orientation.defaultFacing,
          { name: v.name, facing },
          role.split(".")[0] ?? "",
          role,
        );
        expect(f.front, `${pid} ${role} ${v.name ?? ""}`).toBe(side);
      }
      const piece = fromVariant(pid, role, { ...v, uuid: v.asset, wanted: v.asset } as never);
      expect(frontOf(piece), v.name).toEqual(side ? SIDE[side] : null);
    }
  });

  it("no piece with a measured front is visible to generators 1 to 4", () => {
    for (const { role, def } of measured) expect((def.minGenerator ?? 1) >= 5, role).toBe(true);
  });
});
