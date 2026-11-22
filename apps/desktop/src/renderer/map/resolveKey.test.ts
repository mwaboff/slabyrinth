import { describe, expect, it } from "vitest";
import type { DisplayOptions, MapPlan } from "@slabyrinth/core";
import { EXAMPLE_A } from "../bridge/fake/fixtures";
import { resolveKey } from "./resolveClient";

const opts: DisplayOptions = {
  grid: true,
  roomNumbers: true,
  roomNames: true,
  furniture: true,
  gmLayer: false,
  legend: false,
};

const renamed = (plan: MapPlan, name: string): MapPlan => ({
  ...plan,
  levels: plan.levels.map((l, i) =>
    i === 0 ? { ...l, areas: l.areas.map((a, j) => (j === 0 ? { ...a, name } : a)) } : l,
  ),
});

describe("the preview cache key", () => {
  it("changes with the plan's content even when the plan id and version are the same", () => {
    const a = EXAMPLE_A();
    const b = renamed(a, "Crypt");
    const c = renamed(a, "Ossuary");
    expect(a.id).toBe(b.id);
    expect(resolveKey(b, 6, opts)).not.toBe(resolveKey(c, 6, opts));
    // two projects holding different plans under one id (a duplicate, an import) never share a preview
    expect(resolveKey(a, 1, opts)).not.toBe(resolveKey(b, 1, opts));
  });

  it("is stable for the same content", () => {
    const a = EXAMPLE_A();
    expect(resolveKey(a, 3, opts)).toBe(resolveKey(structuredClone(a), 3, opts));
    expect(resolveKey(a, 3, opts)).not.toBe(resolveKey(a, 4, opts));
  });
});
