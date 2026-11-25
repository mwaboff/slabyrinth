/** Test helpers: the realized build of a stored plan, and its scene with stand-in boxes. */
import { readFileSync } from "node:fs";
import {
  loadPalettes,
  parsePlan,
  realize,
  resolvePlan,
  verifyBuild,
  buildPaletteCatalog,
  type MapPlan,
  type PlacementSet,
  type ResolvedPlan,
} from "@slabyrinth/core";
import { boxMeshSource, pieceLookup, sceneFromBuild, type MeshSource, type Scene } from "../src/index";

const PLANS = new URL("../../core/test/fixtures/plans/", import.meta.url);

export function fixturePlan(name: string): MapPlan {
  const r = parsePlan(JSON.parse(readFileSync(new URL(`${name}.json`, PLANS), "utf8")));
  if (!r.ok) throw new Error(`${name}: not a valid plan`);
  return r.plan;
}

export interface Built {
  plan: MapPlan;
  resolved: ResolvedPlan;
  set: PlacementSet;
}

export function buildPlan(plan: MapPlan): Built {
  const palettes = buildPaletteCatalog([], null);
  const resolved = resolvePlan(plan, palettes);
  const set = realize(resolved, palettes, {});
  verifyBuild(resolved, set, palettes, { plan });
  return { plan, resolved, set };
}

export async function fixtureScene(name: string, source: MeshSource = boxMeshSource()): Promise<Scene> {
  const b = buildPlan(fixturePlan(name));
  return sceneFromBuild(b.resolved, b.set, pieceLookup(loadPalettes().palettes, null), source);
}
