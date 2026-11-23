/**
 * The shared auto-palette classifier (palette/autoRoles.ts): its agreement with the curator over the bundled palettes
 * (leave-one-out, from palette data alone), its report over a synthetic catalog, and its policy table.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_POLICY,
  ROLE_FAMILIES,
  classifyNew,
  rolePolicy,
  siblingAgreement,
  stemOf,
} from "../../../src/palette/autoRoles";
import { bundledPalettes } from "../../../src/palette";
import { ADDED, CURATED, SYNTHETIC_CATALOG, SYNTHETIC_PALETTES } from "../../fixtures/catalogSynthetic";

describe("the sibling rule agrees with the curator (leave-one-out over the bundled palettes)", () => {
  const rows = siblingAgreement(bundledPalettes().palettes);
  const covered = rows.filter((r) => r.predicted.length > 0);
  const oneRight = covered.filter((r) => r.predicted.some((p) => r.actual.includes(p)));
  const predicted = covered.reduce((s, r) => s + r.predicted.length, 0);
  const right = covered.reduce((s, r) => s + r.predicted.filter((p) => r.actual.includes(p)).length, 0);

  // Measured 2026-11-23 over 694 pieces: 17.9 % covered, 97.6 % with a right role, 83.0 % of proposed roles right. A
  // floor that falls as curation grows is tuned here, in the same change, with the new measurement.
  it("re-derives a known role for at least 95 % of the pieces it places", () => {
    expect(oneRight.length / covered.length).toBeGreaterThanOrEqual(0.95);
  });
  it("proposes a right role at least 80 % of the time", () => {
    expect(right / predicted).toBeGreaterThanOrEqual(0.8);
  });
  it("places at least 15 % of the palette pieces from their siblings", () => {
    expect(covered.length / rows.length).toBeGreaterThanOrEqual(0.15);
  });
});

describe("stems", () => {
  it("drop numbers, sizes and letter suffixes", () => {
    expect(stemOf("Stalagmite Column 05")).toBe("stalagmite column");
    expect(stemOf("md_wall_1x1_02")).toBe("md wall");
    expect(stemOf("railing 01 B")).toBe("railing");
    expect(stemOf("Stackable Pine Top (Snow)")).toBe("stackable pine top snow");
    expect(stemOf("lamp01")).toBe("lamp");
  });
});

describe("classification of a synthetic catalog", () => {
  const out = classifyNew(SYNTHETIC_CATALOG, SYNTHETIC_PALETTES, {
    seen: new Set([ADDED.seen.uuid]),
    exclude: new Set([ADDED.excluded.uuid]),
  });
  const rows = out.pieces.map((p) => `${p.name} → ${p.theme}/${p.role} ${p.where} w${p.variant.weight ?? 1}`);

  it("adds sure pieces to their sibling's role with the policy's weight and the family's where", () => {
    expect(rows).toEqual([
      "Mossy Rock 02 → grove/feature.rock user w0.25",
      "Old Bone 02 → grove/feature.bones user w0",
      "Iron Lantern 02 → grove/feature.lantern dev w0.25",
      "Grove Floor 02 → grove/floor.grass dev w0.25",
    ]);
  });

  it("inherits the sibling's key and turn, and takes its own geometry from the catalog", () => {
    const rock = out.pieces.find((p) => p.uuid === ADDED.sure.uuid);
    expect(rock?.variant).toMatchObject({ variant: "mossy", rot: 15, footprint: [1, 1] });
    expect(rock?.variant.geom.size).toEqual(ADDED.sure.size);
    expect(rock?.siblings).toEqual([CURATED.rock.name]);
  });

  it("reports a kit whose pieces do not all fit, new kits and keyword-only pieces, and adds none of them", () => {
    expect(out.unsure.map((u) => `${u.name}: ${u.basis} ${u.roles.join(",")}`).sort()).toEqual([
      "Fern Clump 01: keyword feature.ground_cover,feature.tall_grass",
      "Oak Stump 02: sibling ",
      "Oak Stump 03: sibling feature.stump",
      "Strange Idol 01: none ",
    ]);
    expect(out.newKits).toEqual([{ pack: "Kitpack", folder: "Newkit", pieces: 1 }]);
  });

  it("leaves out deprecated, foreign-pack, seen, excluded and marker pieces", () => {
    const named = new Set([...out.pieces, ...out.unsure].map((p) => p.uuid));
    for (const a of [ADDED.deprecated, ADDED.foreign, ADDED.seen, ADDED.excluded, ADDED.marker])
      expect(named.has(a.uuid)).toBe(false);
  });

  it("gives the same answer for the same catalog in any order", () => {
    const again = classifyNew([...SYNTHETIC_CATALOG].reverse(), SYNTHETIC_PALETTES, {
      seen: new Set([ADDED.seen.uuid]),
      exclude: new Set([ADDED.excluded.uuid]),
    });
    expect(again).toEqual(out);
  });
});

describe("the policy table", () => {
  it("has a row for every role family of the bundled palettes", () => {
    const families = new Set<string>();
    for (const p of Object.values(bundledPalettes().palettes))
      for (const role of Object.keys(p.roles)) families.add(role.split(".")[0] ?? role);
    const listed: ReadonlySet<string> = new Set(ROLE_FAMILIES);
    expect([...families].filter((f) => !listed.has(f))).toEqual([]);
    expect(Object.keys(AUTO_POLICY).sort()).toEqual([...ROLE_FAMILIES].sort());
  });

  it("never lets a user's machine extend a structural role, a light or what other pieces stand on", () => {
    const structural = ["floor.grass", "wall.wall", "wall_post.wall", "roof.slate.slope", "opening.door"];
    for (const role of [
      ...structural,
      "link.stairs",
      "stairs.stone",
      "ship.deck",
      "light.glow",
      "cliff.rock",
    ])
      expect(rolePolicy(role).where, role).not.toBe("user");
    for (const role of [
      "feature.lantern",
      "feature.brazier",
      "feature.table",
      "feature.pillar",
      "feature.chair",
    ])
      expect(rolePolicy(role).where, role).toBe("dev");
    expect(rolePolicy("marker.alignment").where).toBe("never");
    expect(rolePolicy("mystery.thing").where).toBe("dev");
    for (const role of ["feature.rock", "feature.bones", "feature.ground_cover", "feature.clutter"])
      expect(rolePolicy(role).where, role).toBe("user");
  });
});
