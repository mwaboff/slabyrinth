/**
 * The ship kit: the vessel recipe asks for the game's own ship pieces first and falls back to today's stand-ins. The
 * kit's roles are imported from scripts/palette-ship-assets.json into generic (every one `minGenerator: 5`). The test
 * checks the recipe picks kit pieces from the bundled palettes, and today's stand-ins, unchanged, when the kit is
 * hidden from the generator that builds.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PaletteCatalog } from "../../../src/contracts/compiler";
import { buildObject, createKit, piecesOf, vessel, type BuiltObject } from "../../../src/objects";
import { loadPalettes } from "../../../src/palette";
import { createPlanRoles } from "../../../src/palette/planRoles";
import { withoutShipKit } from "./proof";

interface ShipEntry {
  readonly to: string;
  readonly uuid: string;
  readonly name: string;
}

const LIST = fileURLToPath(new URL("../../../scripts/palette-ship-assets.json", import.meta.url));
const entries = (JSON.parse(readFileSync(LIST, "utf8")) as { entries: ShipEntry[] }).entries;

/** The palettes with the ship kit's roles taken out altogether (no theme lists them). */
function noShipRoles(base: PaletteCatalog): PaletteCatalog {
  const out = { ...base, palettes: structuredClone(base.palettes) };
  for (const p of Object.values(out.palettes))
    p.roles = Object.fromEntries(Object.entries(p.roles).filter(([name]) => !name.startsWith("ship.")));
  return out;
}

const roleCount = (o: BuiltObject, role: string): number =>
  piecesOf(o).filter((q) => q.piece.role === role).length;
const shipRoles = (o: BuiltObject): string[] =>
  [...new Set(piecesOf(o).map((q) => q.piece.role))].filter((r) => r.startsWith("ship.")).sort();
const brig = (cat: PaletteCatalog, more: object = {}): BuiltObject =>
  buildObject(
    vessel,
    { size: 30, seed: "kit-brig", sails: "set", ...more },
    createKit(createPlanRoles(cat, 5), "wood_town"),
  );

describe("the ship kit list (scripts/palette-ship-assets.json)", () => {
  it("names each asset once per role, every role in the ship family", () => {
    const seen = new Set<string>();
    for (const e of entries) {
      expect(e.to.startsWith("ship.")).toBe(true);
      const k = `${e.to}|${e.uuid}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    expect(entries.length).toBeGreaterThan(100);
  });

  it("is imported whole into generic, every role for generator 5 on", () => {
    const generic = loadPalettes().palettes["generic"];
    for (const e of entries) {
      const role = generic?.roles[e.to];
      expect(role?.minGenerator, e.to).toBe(5);
      expect(role?.variants.some((v) => v.asset === e.uuid)).toBe(true);
    }
  });
});

describe("the vessel recipe asks for the ship kit first", () => {
  const kitCat = loadPalettes();
  const bundled = withoutShipKit(kitCat);

  it("builds a brig from kit pieces when the palettes have them", () => {
    const o = brig(kitCat);
    expect(roleCount(o, "ship.mast")).toBeGreaterThan(4);
    expect(roleCount(o, "ship.sail_set")).toBeGreaterThan(0);
    expect(roleCount(o, "ship.sail_furled")).toBeGreaterThan(0);
    expect(roleCount(o, "ship.deck")).toBeGreaterThan(10);
    expect(shipRoles(o)).toEqual(
      expect.arrayContaining([
        "ship.anchor",
        "ship.cargo",
        "ship.deck",
        "ship.grating",
        "ship.helm",
        "ship.lantern",
        "ship.mast",
        "ship.sail_furled",
        "ship.sail_set",
        "ship.spar",
      ]),
    );
    // no banner or wall dressing stands in for a sail when the kit has sails
    expect(piecesOf(o).some((q) => q.piece.role.startsWith("feature.banner"))).toBe(false);
  });

  it("uses today's stand-ins, and no ship piece, when the palettes lack the kit", () => {
    const o = brig(bundled);
    expect(shipRoles(o)).toEqual([]);
    expect(roleCount(o, "feature.line_post") + roleCount(o, "porch_post.default")).toBeGreaterThan(0);
  });

  it("builds exactly today's vessel when the kit's roles are hidden from its generator", () => {
    // the kit for generator 6 only: generator 5 sees none of it and builds as palettes without the roles do
    const hidden = bundled;
    const removed = noShipRoles(kitCat);
    for (const size of [6, 14, 30]) {
      const a = piecesOf(
        buildObject(vessel, { size, seed: "same" }, createKit(createPlanRoles(removed, 5), "wood_town")),
      );
      const b = piecesOf(
        buildObject(vessel, { size, seed: "same" }, createKit(createPlanRoles(hidden, 5), "wood_town")),
      );
      const key = (q: (typeof a)[number]): string =>
        `${q.piece.variant.uuid} ${q.x.toFixed(4)} ${q.y.toFixed(4)} ${q.z.toFixed(4)} ${q.yaw}`;
      expect(b.map(key)).toEqual(a.map(key));
    }
  });

  it("builds a barge and a rowing boat from the kit without errors", () => {
    const kit = createKit(createPlanRoles(kitCat, 5), "wood_town");
    const barge = buildObject(vessel, { size: 14, seed: "kit-barge" }, kit);
    const boat = buildObject(vessel, { size: 6, seed: "kit-boat" }, kit);
    expect(roleCount(barge, "ship.deck")).toBeGreaterThan(0);
    expect(barge.over).toBe(false);
    expect(boat.over).toBe(false);
  });
});
