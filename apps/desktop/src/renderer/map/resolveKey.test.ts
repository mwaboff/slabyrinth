import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DisplayOptions, MapPlan } from "@slabyrinth/core";
import { setBridge } from "../bridge/client";
import { createFakeBridge, parseScenario } from "../bridge/fake/fakeBridge";
import { EXAMPLE_A } from "../bridge/fake/fixtures";
import {
  PREVIEW_CACHE_CELLS,
  clearPreviewCache,
  planCells,
  previewCacheSize,
  resolveAsync,
  resolveKey,
} from "./resolveClient";

// the resolve itself, counted and kept cheap: these tests are about the cache around it
const computed = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../shared/resolveCore", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../shared/resolveCore")>();
  return {
    ...real,
    compute: (req: { options: DisplayOptions }) => {
      computed.n++;
      const resolved = { levels: [], links: [] } as unknown as ReturnType<typeof real.compute>["resolved"];
      return { resolved, lists: real.displayLists(resolved, {}, req.options), labels: {}, issues: [] };
    },
  };
});

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

/** EXAMPLE_A on one level of `side` cells a side (only the bounds matter to the cache). */
const sized = (side: number, name: string): MapPlan => {
  const a = renamed(EXAMPLE_A(), name);
  return {
    ...a,
    levels: [{ ...(a.levels[0] as MapPlan["levels"][number]), bounds: { x: 0, y: 0, w: side, h: side } }],
  };
};

describe("the preview cache key", () => {
  it("changes with the plan's content even when the plan id and version are the same", () => {
    const a = EXAMPLE_A();
    const b = renamed(a, "Crypt");
    const c = renamed(a, "Ossuary");
    expect(a.id).toBe(b.id);
    expect(resolveKey(b, 6)).not.toBe(resolveKey(c, 6));
    // two projects holding different plans under one id (a duplicate, an import) never share a preview
    expect(resolveKey(a, 1)).not.toBe(resolveKey(b, 1));
  });

  it("is stable for the same content", () => {
    const a = EXAMPLE_A();
    expect(resolveKey(a, 3)).toBe(resolveKey(structuredClone(a), 3));
    expect(resolveKey(a, 3)).not.toBe(resolveKey(a, 4));
  });
});

describe("the preview cache", () => {
  beforeAll(() => {
    setBridge(createFakeBridge({ scenario: parseScenario(""), speed: 0 }));
  });
  afterEach(() => {
    clearPreviewCache();
    computed.n = 0;
  });

  it("resolves once per plan: a display toggle only builds new display lists", async () => {
    const plan = EXAMPLE_A();
    await resolveAsync(plan, 1, opts);
    await resolveAsync(plan, 1, { ...opts, grid: false });
    await resolveAsync(plan, 1, { ...opts, gmLayer: true });
    await resolveAsync(plan, 1, opts);
    expect(computed.n).toBe(1);
    expect(previewCacheSize().entries).toBe(1);
  });

  it("is bounded by the cells it holds, not by its entry count", async () => {
    for (let i = 0; i < 8; i++) await resolveAsync(sized(1024, `big ${String(i)}`), 1, opts);
    const big = previewCacheSize();
    expect(big.cells).toBeLessThanOrEqual(PREVIEW_CACHE_CELLS);
    expect(big.entries).toBe(Math.floor(PREVIEW_CACHE_CELLS / planCells(sized(1024, "x"))));
    clearPreviewCache();
    // small maps: the old 24-entry cap still holds
    for (let i = 0; i < 30; i++) await resolveAsync(sized(40, `small ${String(i)}`), 1, opts);
    expect(previewCacheSize().entries).toBe(24);
  });
});
