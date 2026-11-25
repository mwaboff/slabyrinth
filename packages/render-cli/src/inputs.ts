/** What the render command draws: stored fixture plans, a plan file, or a slab file; and building a plan. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATOR_VERSIONS,
  decodeDetailed,
  parseJsonText,
  parsePlan,
  realize,
  resolvePlan,
  verifyBuild,
  type CompileDiagnostic,
  type GeneratorVersion,
  type MapPlan,
  type PaletteCatalog,
  type PlacementSet,
  type ResolvedPlan,
  type SlabAsset,
} from "@slabyrinth/core";
import { UsageError } from "./args";

/** The repository root (this file is packages/render-cli/src/inputs.ts). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Where stored plans live (core's test fixtures: the hand-written plans and the generator test plans). */
export const FIXTURE_DIRS = [
  join(REPO_ROOT, "packages", "core", "test", "fixtures", "plans"),
  join(REPO_ROOT, "packages", "core", "test", "unit", "gen", "fixtures"),
];

export type Input =
  { kind: "plan"; name: string; plan: MapPlan } | { kind: "slab"; name: string; assets: SlabAsset[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function planOrThrow(raw: unknown, where: string): MapPlan {
  // a plan, or an exported document that wraps one ({ format, plan })
  const r = parsePlan(isRecord(raw) && "format" in raw && "plan" in raw ? raw["plan"] : raw);
  if (r.ok) return r.plan;
  const shown = r.issues.slice(0, 5).map((i) => `  ${i.path ? `${i.path}: ` : ""}${i.message}`);
  throw new Error(`${where} is not a valid plan:\n${shown.join("\n")}`);
}

/** Every stored plan's name, sorted. */
export function fixtureNames(): string[] {
  return FIXTURE_DIRS.flatMap((d) =>
    existsSync(d)
      ? readdirSync(d)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
      : [],
  ).sort();
}

export function loadFixture(name: string): Input {
  for (const d of FIXTURE_DIRS) {
    const f = join(d, `${name}.json`);
    if (existsSync(f))
      return { kind: "plan", name, plan: planOrThrow(parseJsonText(readFileSync(f, "utf8")), f) };
  }
  throw new UsageError(
    `--fixture ${name}: no stored plan of that name (one of: ${fixtureNames().join(", ")})`,
  );
}

export function loadPlanFile(path: string, cwd: string): Input {
  const f = resolve(cwd, path);
  return {
    kind: "plan",
    name: basename(f).replace(/\.json$/i, ""),
    plan: planOrThrow(parseJsonText(readFileSync(f, "utf8")), f),
  };
}

/** A slab file: one chunk per line (fences and blank lines allowed), every chunk pasted at the same origin. */
export function loadSlabFile(path: string, cwd: string): Input {
  const f = resolve(cwd, path);
  const assets: SlabAsset[] = [];
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("```")) continue;
    for (const a of decodeDetailed(t).assets) assets.push(a);
  }
  if (assets.length === 0) throw new Error(`${f}: no slab in the file`);
  return { kind: "slab", name: basename(f).replace(/\.[^.]+$/, ""), assets };
}

/** The plan at another generator and root seed (the sweep's way: the plan's own words, re-seeded). */
export function variant(plan: MapPlan, o: { generator?: number; seed?: number }): MapPlan {
  const out: MapPlan = { ...plan };
  if (o.generator !== undefined) {
    if (!(GENERATOR_VERSIONS as readonly number[]).includes(o.generator))
      throw new UsageError(`--generator ${o.generator}: one of ${GENERATOR_VERSIONS.join(", ")}`);
    out.generator = o.generator as GeneratorVersion;
  }
  if (o.seed !== undefined) out.seed = o.seed;
  return out;
}

export interface Built {
  resolved: ResolvedPlan;
  set: PlacementSet;
  /** Verify's errors and warnings (the build is drawn anyway). */
  problems: CompileDiagnostic[];
}

/** resolve → realize → verify, as compile does (verify may nudge props); no chunking. */
export function buildPlan(plan: MapPlan, palettes: PaletteCatalog): Built {
  const resolved = resolvePlan(plan, palettes);
  const set = realize(resolved, palettes, {});
  const verify = verifyBuild(resolved, set, palettes, {
    plan,
    ...(plan.entryLevel ? { entryLevelId: plan.entryLevel } : {}),
  });
  const problems = [...set.diagnostics, ...verify.diagnostics].filter((d) => d.severity !== "info");
  return { resolved, set, problems };
}
