/**
 * Golden for one structure plan (a cottage with chimney and porch in a fenced yard): ASCII view, outline lines and
 * every placement the build makes for the structures. Any change to the construction rules shows up here.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { placedName, realize } from "../../../src/compile";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { asciiView, outlineView } from "../../../src/text";

const PLAN: MapPlan = {
  schema: "slabyrinth/plan@1",
  generator: 2,
  id: "golden-structures",
  title: "Cottage in a yard",
  kind: "outdoor",
  seed: 4242,
  theme: "forest",
  links: [],
  levels: [
    {
      id: "g",
      name: "Yard",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 22, h: 18 },
      base: { type: "ground", material: "grass" },
      // the golden pins the structures, not the natural board outline
      outline: "rect",
      areas: [],
      openings: [],
      walls: [],
      features: [],
      terrain: [],
      labels: [],
      structures: [
        {
          id: "yard",
          kind: "enclosure",
          name: "Yard",
          shape: { type: "rect", x: 2, y: 2, w: 18, h: 14 },
          wall: "fence",
          gates: [{ side: "S", position: 0.5, width: 2 }],
        },
        {
          id: "cottage",
          name: "Cottage",
          key: "1",
          style: "cottage",
          wings: [{ x: 7, y: 5, w: 6, h: 4 }],
          roof: { type: "gable" }, // pinned: the phase-1 cottage (a designed cottage varies with the seed)
          openings: [{ kind: "door", side: "S", position: 0.5 }],
          chimneys: [{ side: "W" }],
          attachments: [{ type: "porch", side: "S", width: 4, depth: 2 }],
        },
      ],
    },
  ],
};

describe("structures golden", () => {
  const resolved = resolvePlan(PLAN, bundledPalettes());
  it("ascii and outline", async () => {
    const text = [
      asciiView(resolved, "g"),
      outlineView(PLAN, resolved)
        .split("\n")
        .filter((l) => l.includes("STRUCT"))
        .join("\n"),
    ].join("\n");
    await expect(text + "\n").toMatchFileSnapshot("__golden__/structures-cottage.txt");
  });
  it("placements of the structures", async () => {
    const set = realize(resolved, loadPalettes());
    const lines = (set.levels[0]?.placements ?? [])
      .filter((p) => /^(cottage|yard)/.test(p.source.elementId ?? ""))
      .map(
        (p) =>
          `${p.source.elementId} ${p.layer ?? "site"} ${p.role} ${placedName(set, p)} ${p.x},${p.y},${p.z} r${p.rot}`,
      );
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("__golden__/structures-cottage.placements.txt");
  });
});
