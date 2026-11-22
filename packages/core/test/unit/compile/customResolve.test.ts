/**
 * Custom features resolve to a real match or to nothing (city-street baseline, 2026-11-20): "car" became a
 * cardboard Carton, "fire hydrant" a fireplace bellows, "bus stop shelter" a Stop sign — a wrong object is worse
 * than none. Strict name search (whole words, the hint's head noun in the name) and a plausible footprint; when
 * nothing qualifies, nothing is placed and an info diagnostic names the feature. Runs against the local catalog
 * index (never committed); skipped when none is present (CI).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogAsset } from "../../../src/contracts/compiler";
import { placedName, realize } from "../../../src/compile";
import { createAvailability } from "../../../src/catalog";
import { loadPalettes } from "../../../src/palette";
import { handLevel, handPlan } from "./handResolved";

function findCatalog(): CatalogAsset[] | null {
  const candidates = [
    process.env["SLABYRINTH_CATALOG"],
    process.env["APPDATA"]
      ? join(process.env["APPDATA"], "Slabyrinth", "catalog", "catalog.json")
      : undefined,
    join(homedir(), ".config", "Slabyrinth", "catalog", "catalog.json"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const raw = JSON.parse(readFileSync(p, "utf8")) as { catalog?: { assets: CatalogAsset[] } };
    if (raw.catalog?.assets.length) return raw.catalog.assets;
  }
  return null;
}

const catalog = findCatalog();

describe.skipIf(catalog === null)("custom features: a real match or nothing", () => {
  const cat = loadPalettes({ availability: createAvailability(catalog ?? []), catalog: catalog ?? [] });
  const resolveOne = (hint: string, size: [number, number]): { name: string | null; severity?: string } => {
    const set = realize(
      handPlan([
        handLevel({
          id: "l1",
          rows: ["########", "#......#", "#......#", "#......#", "#......#", "########"],
          features: [{ id: "x", type: "custom", at: [2, 2], hint, size }],
        }),
      ]),
      cat,
    );
    const p = set.levels[0]?.placements.find((q) => q.source.elementId === "x");
    const d = set.diagnostics.find((q) => q.code === "custom_unresolved");
    return {
      name: p ? placedName(set, p) : null,
      ...(d ? { severity: d.severity } : {}),
    };
  };

  it("a car is a vehicle, never a cardboard carton", () => {
    const r = resolveOne("car", [3, 2]);
    expect(r.name ?? "").not.toMatch(/carton/i);
    if (r.name) expect(r.name).toMatch(/\bcar\b/i);
  });

  it("a fire hydrant with no hydrant asset places nothing (not a fireplace bellows), with an info note", () => {
    expect(resolveOne("fire hydrant", [1, 1])).toEqual({ name: null, severity: "info" });
  });

  it("a bus stop shelter with no shelter asset places nothing (not a Stop sign)", () => {
    expect(resolveOne("bus stop shelter", [3, 1])).toEqual({ name: null, severity: "info" });
  });

  it("real matches still resolve: street lamp, traffic light, taxi", () => {
    expect(resolveOne("street lamp", [1, 1]).name).toMatch(/street lamp/i);
    expect(resolveOne("traffic light", [1, 1]).name).toMatch(/traffic ?light|traficlight/i);
    expect(resolveOne("taxi", [3, 2]).name).toMatch(/taxi/i);
  });
});
