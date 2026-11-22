/** Outline and ASCII snapshots for every fixture (architecture §3.3, §7.3). */
import { describe, expect, it } from "vitest";
import { bundledPalettes } from "../../../src/palette";
import { levelLabels } from "../../../src/render/index";
import { geometryChecks, resolvePlan } from "../../../src/resolve/index";
import { asciiView, changedRegionViews, outlineView } from "../../../src/text/index";
import { allFixtures } from "../resolve/allFixtures";

const fixtures = allFixtures();

describe("outline view", () => {
  it.each(fixtures)("%s", async (name, plan) => {
    const r = resolvePlan(plan, bundledPalettes());
    const text = outlineView(plan, r, { version: 7, issues: geometryChecks(plan, bundledPalettes(), { resolved: r }) });
    await expect(text + "\n").toMatchFileSnapshot(`__golden__/${name}.outline.txt`);
  });
});

describe("ascii view", () => {
  it.each(fixtures)("%s", async (name, plan) => {
    const r = resolvePlan(plan, bundledPalettes());
    const labels = levelLabels(r, plan.entryLevel);
    const text = r.levels
      .map((l) => `LEVEL ${l.id}\n${asciiView(r, l.id, { levelLabels: labels })}`)
      .join("\n\n");
    await expect(text + "\n").toMatchFileSnapshot(`__golden__/${name}.ascii.txt`);
  });

  it("switches to one char per cell above 60 cells and crops on request", () => {
    const plan = fixtures.find(([n]) => n === "example-b")?.[1];
    if (!plan) throw new Error("example-b");
    const big = structuredClone(plan);
    const lvl = big.levels[0];
    if (!lvl) throw new Error("level");
    lvl.bounds = { x: 0, y: 0, w: 70, h: 40 };
    const r = resolvePlan(big, bundledPalettes());
    const wide = asciiView(r, "g");
    expect(wide).toContain("1 char per cell");
    const crop = asciiView(r, "g", { region: { x: 16, y: 9, w: 12, h: 11 } });
    expect(crop).not.toContain("1 char per cell");
    expect(crop).toContain("[1]");
    expect(crop.split("\n")[1]?.length).toBeLessThanOrEqual(4 + 25);
  });
});

describe("changed-region view", () => {
  it("crops to the changed bbox ±3 and stays in budget", async () => {
    const plan = fixtures.find(([n]) => n === "example-a")?.[1];
    if (!plan) throw new Error("example-a");
    const before = resolvePlan(plan, bundledPalettes());
    const edited = structuredClone(plan);
    edited.levels[0]?.features.push({ id: "fountain1", type: "fountain", at: [15, 9] });
    const after = resolvePlan(edited, bundledPalettes());
    const { views, fits } = changedRegionViews(before, after);
    expect(fits).toBe(true);
    expect(views.map((v) => [v.levelId, v.region])).toEqual([["l1", { x: 12, y: 6, w: 8, h: 8 }]]);
    await expect(views.map((v) => v.text).join("\n") + "\n").toMatchFileSnapshot(
      "__golden__/changed-example-a.txt",
    );
  });
  it("reports nothing for an unchanged plan and the whole level for a new one", () => {
    const plan = fixtures[0]?.[1];
    if (!plan) throw new Error("plan");
    const r = resolvePlan(plan, bundledPalettes());
    expect(changedRegionViews(r, r).views).toEqual([]);
    expect(changedRegionViews(null, r, { maxChars: 1e6 }).views.length).toBe(r.levels.length);
  });
  it("degrades when over budget", () => {
    const plan = fixtures.find(([n]) => n === "example-b")?.[1];
    if (!plan) throw new Error("example-b");
    const res = changedRegionViews(null, resolvePlan(plan, bundledPalettes()), { maxChars: 500 });
    expect(res.fits).toBe(false);
  });
});
