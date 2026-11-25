/** What the render command draws: stored fixture plans, a plan file, or a slab file; and building a plan. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GENERATOR_VERSIONS,
  decodeDetailed,
  parseJsonText,
  parsePlan,
  realize,
  resolvePlan,
  resolveWithObjects,
  verifyBuild,
  type CompileDiagnostic,
  type GeneratorVersion,
  type MapPlan,
  type ObjectSpec,
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
  | { kind: "plan"; name: string; plan: MapPlan; objects?: readonly ObjectSpec[] }
  | { kind: "slab"; name: string; assets: SlabAsset[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function planOrThrow(raw: unknown, where: string): MapPlan {
  // a plan, or an exported document that wraps one ({ format, plan })
  const r = parsePlan(isRecord(raw) && "format" in raw && "plan" in raw ? raw["plan"] : raw);
  if (r.ok) return r.plan;
  const shown = r.issues.slice(0, 5).map((i) => `  ${i.path ? `${i.path}: ` : ""}${i.message}`);
  throw new Error(`${where} is not a valid plan:\n${shown.join("\n")}`);
}

/**
 * Stored scenes built in code (core's test fixtures that place objects no plan word asks for yet): name → the module
 * under packages/core/test/fixtures and how to read its plan and object specs.
 */
const CODE_FIXTURES: Readonly<
  Record<string, { file: string; read: (m: Record<string, unknown>) => { plan: unknown; objects: unknown } }>
> = {
  harbour: {
    file: "harbour.ts",
    read: (m) => ({
      plan: typeof m["harbourPlan"] === "function" ? (m["harbourPlan"] as () => unknown)() : null,
      objects: m["HARBOUR_SPECS"],
    }),
  },
};

/** Every stored plan's name, sorted (the plans in files and the scenes built in code). */
export function fixtureNames(): string[] {
  return [
    ...FIXTURE_DIRS.flatMap((d) =>
      existsSync(d)
        ? readdirSync(d)
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.slice(0, -5))
        : [],
    ),
    ...Object.keys(CODE_FIXTURES),
  ].sort();
}

/** Object specs as a plan file or a code fixture gives them (checked for the fields the site stage reads). */
function objectsOrThrow(raw: unknown, where: string): ObjectSpec[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: "objects" is not a list`);
  return raw.map((o, i) => {
    if (
      !isRecord(o) ||
      typeof o["id"] !== "string" ||
      o["kind"] !== "vessel" ||
      typeof o["level"] !== "string" ||
      !Array.isArray(o["at"]) ||
      typeof o["heading"] !== "number" ||
      typeof o["size"] !== "number"
    )
      throw new Error(`${where}: objects[${i}] is not an object spec (id, kind, level, at, heading, size)`);
    return o as unknown as ObjectSpec;
  });
}

export async function loadFixture(name: string): Promise<Input> {
  for (const d of FIXTURE_DIRS) {
    const f = join(d, `${name}.json`);
    if (existsSync(f))
      return { kind: "plan", name, plan: planOrThrow(parseJsonText(readFileSync(f, "utf8")), f) };
  }
  const code = CODE_FIXTURES[name];
  if (code) {
    const file = join(REPO_ROOT, "packages", "core", "test", "fixtures", code.file);
    const m = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const r = code.read(m);
    return { kind: "plan", name, plan: planOrThrow(r.plan, file), objects: objectsOrThrow(r.objects, file) };
  }
  throw new UsageError(
    `--fixture ${name}: no stored plan of that name (one of: ${fixtureNames().join(", ")})`,
  );
}

/** A plan file: a plan, an exported { format, plan } document, or { plan, objects } (a plan with objects on it). */
export function loadPlanFile(path: string, cwd: string): Input {
  const f = resolve(cwd, path);
  const raw = parseJsonText(readFileSync(f, "utf8"));
  const name = basename(f).replace(/\.json$/i, "");
  if (isRecord(raw) && "objects" in raw && "plan" in raw)
    return {
      kind: "plan",
      name,
      plan: planOrThrow(raw["plan"], f),
      objects: objectsOrThrow(raw["objects"], f),
    };
  return { kind: "plan", name, plan: planOrThrow(raw, f) };
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
  /** The objects placed on the plan and the way each faces (degrees clockwise from plan north). */
  objects: Array<{ id: string; heading: number }>;
}

/**
 * resolve → realize → verify, as compile does (verify may nudge props); no chunking. Objects (vessels) go through the
 * site stage first, as a future plan field would pass them.
 */
export function buildPlan(
  plan: MapPlan,
  palettes: PaletteCatalog,
  objects: readonly ObjectSpec[] = [],
): Built {
  const withObjects = objects.length > 0 ? resolveWithObjects(plan, objects, palettes) : null;
  const resolved = withObjects ? withObjects.resolved : resolvePlan(plan, palettes);
  const built = withObjects ? withObjects.plan : plan;
  const set = realize(resolved, palettes, {});
  const verify = verifyBuild(resolved, set, palettes, {
    plan: built,
    ...(built.entryLevel ? { entryLevelId: built.entryLevel } : {}),
  });
  const problems = [...set.diagnostics, ...verify.diagnostics].filter((d) => d.severity !== "info");
  return {
    resolved,
    set,
    problems,
    objects: (withObjects?.sites ?? []).map((s) => ({ id: s.spec.id, heading: s.spec.heading })),
  };
}
