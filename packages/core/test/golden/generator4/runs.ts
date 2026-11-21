/**
 * The runs the generator-4 golden pins, and the record each run is reduced to. Shared by generator4.test.ts (which
 * only reads the golden) and update.ts (the one thing that writes it). See the header of generator4.test.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { compileResolved, realize } from "../../../src/compile";
import type { CompileDiagnostic, PlacementSet } from "../../../src/contracts/compiler";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedPlan } from "../../../src/contracts/resolved";
import { loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { designReviewText, reviewDesign, type DesignNote } from "../../../src/review";
import { slabCodec } from "../../../src/slab";
import { GENERATOR_TEST_PLANS, loadPlan, STORED_PLANS, type StoredPlan } from "../../fixtures";

/** The generator this golden follows while it is open. When it ships, see the header of generator4.test.ts. */
export const OPEN_GENERATOR = 4;

export const GOLDEN_FILE = new URL("__golden__/generator4.txt", import.meta.url);
/** The readable sidecar: what each run built, one fact per line, each line starting with the run's name. */
export const DETAIL_FILE = new URL("__golden__/generator4.detail.txt", import.meta.url);

/** The stored plans, by the short name of their directory, which a run is called after. */
const STORED: ReadonlyArray<readonly [string, readonly StoredPlan[]]> = [
  ["plans", STORED_PLANS],
  ["gen", GENERATOR_TEST_PLANS],
];

export interface Run {
  /** `<dir>/<file>` at the plan's own generator, `<dir>/<file>@4` for a plan of a released generator forced to 4. */
  name: string;
  plan: MapPlan;
}

/**
 * Every stored plan at its own generator, and every plan of a released generator forced to the open one too (so the
 * open generator's switches are exercised on terrain, caves and towns, not only on the plans written for it).
 */
export function goldenRuns(): Run[] {
  const runs: Run[] = [];
  for (const [dirName, names] of STORED)
    for (const stored of [...names].sort()) {
      const plan = loadPlan(stored);
      const name = `${dirName}/${stored}`;
      runs.push({ name, plan });
      if (plan.generator !== OPEN_GENERATOR)
        runs.push({
          name: `${name}@${String(OPEN_GENERATOR)}`,
          plan: loadPlan(stored, { generator: OPEN_GENERATOR }),
        });
    }
  return runs;
}

/**
 * Fields of a record that are part of a released generator's frozen output (the same things the generator-2 and
 * generator-3 goldens pin). The design review and the diagnostic wording are advice, not the build, and may change
 * on any generator (src/plan/generator.ts, "Review policy").
 */
export const FROZEN_FIELDS = ["resolved", "assets", "diag", "slab"] as const;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

let palettes: ReturnType<typeof loadPalettes> | undefined;

/** What one run is reduced to: the hash line, and the readable detail lines (each starting with the run's name). */
export interface GoldenRecord {
  line: string;
  detail: string[];
}

/**
 * One run through the pipeline the CLI's `build` and `review` commands use (src/cli/index.ts): resolve against the
 * palettes the plan is compiled with, compile (realize, verify, chunk, encode), then the design review with the build
 * and without it. The line is the run's name, then `key=value` fields; the detail says what was built (runDetail).
 */
export function goldenRecord(run: Run): GoldenRecord {
  palettes ??= loadPalettes();
  const { plan } = run;
  const fields: Array<[string, string | number]> = [["gen", plan.generator]];
  let detail: string[];
  try {
    const resolved = resolvePlan(plan, palettes);
    const bundle = compileResolved(resolved, palettes, slabCodec, { createdAt: "t", plan });
    const placements = realize(resolved, palettes, {});
    const withBuild = reviewDesign(plan, resolved, palettes, { diagnostics: bundle.diagnostics, placements });
    const noBuild = reviewDesign(plan, resolved, palettes);
    const count = (s: string): number => bundle.diagnostics.filter((d) => d.severity === s).length;
    fields.push(
      ["resolved", resolved.hash],
      ["assets", bundle.chunks.reduce((n, c) => n + c.assetCount, 0)],
      ["diag", `${String(count("error"))}e/${String(count("warning"))}w/${String(count("info"))}i`],
      ["slab", sha(bundle.chunks.map((c) => c.slab).join("\n"))],
      ["diagnostics", sha(JSON.stringify(bundle.diagnostics))],
      ["review", sha(JSON.stringify(withBuild) + "\n" + designReviewText(withBuild))],
      ["reviewNoBuild", sha(JSON.stringify(noBuild) + "\n" + designReviewText(noBuild))],
    );
    detail = runDetail(run.name, resolved, placements, bundle.diagnostics, withBuild);
  } catch (e) {
    // a plan that stops resolving or compiling is a change too; keep the message on one line
    fields.push(["error", JSON.stringify(e instanceof Error ? e.message : String(e))]);
    detail = [`${run.name} error`];
  }
  return { line: [run.name, ...fields.map(([k, v]) => `${k}=${String(v)}`)].join(" "), detail };
}

/** The hash line of a run (goldenRecord's line). */
export const goldenLine = (run: Run): string => goldenRecord(run).line;

/** `key n` counts of a list, sorted by key. */
function counted(keys: Iterable<string>): Array<[string, number]> {
  const n = new Map<string, number>();
  for (const k of keys) n.set(k, (n.get(k) ?? 0) + 1);
  return [...n].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The readable record of a run, one fact per line so a diff names what moved ("market-street-v3 g part apothecary~chimney
 * 15" gone means the apothecary lost its chimney):
 * - per level: placed pieces by placement role (`pieces`), by paste layer (`layer`), and by the structure part or
 *   floor role that made them (`part`: the element ids with a `~` or a `floor:` prefix; other pieces are counted by
 *   role only, since generated dressing ids are many);
 * - per level: resolved features by type (`feature`);
 * - the build's diagnostics by severity and code (`diag`), and the review's notes (with the build) by code (`review`).
 */
export function runDetail(
  name: string,
  resolved: ResolvedPlan,
  placements: PlacementSet,
  diagnostics: readonly CompileDiagnostic[],
  notes: readonly DesignNote[],
): string[] {
  const out: string[] = [];
  for (const L of placements.levels) {
    const at = `${name} ${L.levelId}`;
    for (const [k, n] of counted(L.placements.map((p) => p.role))) out.push(`${at} pieces ${k} ${String(n)}`);
    for (const [k, n] of counted(L.placements.map((p) => p.layer ?? "site")))
      out.push(`${at} layer ${k} ${String(n)}`);
    const parts = L.placements
      .map((p) => String(p.source.elementId ?? ""))
      .filter((id) => id.includes("~") || id.startsWith("floor:"));
    for (const [k, n] of counted(parts)) out.push(`${at} part ${k} ${String(n)}`);
  }
  for (const L of resolved.levels)
    for (const [k, n] of counted(L.features.map((f) => f.type)))
      out.push(`${name} ${L.id} feature ${k} ${String(n)}`);
  for (const [k, n] of counted(diagnostics.map((d) => `${d.severity} ${d.code}`)))
    out.push(`${name} diag ${k} ${String(n)}`);
  for (const [k, n] of counted(notes.map((d) => d.code))) out.push(`${name} review ${k} ${String(n)}`);
  return out;
}

/** A golden line split into its name and fields. Field values never contain a space except a quoted error. */
export function parseLine(line: string): { name: string; fields: Map<string, string> } {
  const [name = "", ...rest] = line.split(" ");
  const fields = new Map<string, string>();
  let last = "";
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq > 0 && last !== "error") {
      last = part.slice(0, eq);
      fields.set(last, part.slice(eq + 1));
    } else fields.set(last, `${fields.get(last) ?? ""} ${part}`);
  }
  return { name, fields };
}

const fileLines = (file: URL): string[] =>
  existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];

/** The committed golden lines, by run name (empty when the file does not exist yet). */
export function readGolden(): Map<string, string> {
  return new Map(fileLines(GOLDEN_FILE).map((l) => [parseLine(l).name, l]));
}

/** The committed detail lines, by run name (every line starts with its run's name). */
export function readDetail(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of fileLines(DETAIL_FILE)) {
    const name = l.slice(0, l.indexOf(" "));
    out.set(name, [...(out.get(name) ?? []), l]);
  }
  return out;
}

/** Field-by-field differences between two lines of the same run (`field: was -> now`). */
export function lineDiff(was: string | undefined, now: string | undefined): string[] {
  const a = was ? parseLine(was).fields : new Map<string, string>();
  const b = now ? parseLine(now).fields : new Map<string, string>();
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  return keys
    .filter((k) => a.get(k) !== b.get(k))
    .map((k) => `${k}: ${a.get(k) ?? "(none)"} -> ${b.get(k) ?? "(none)"}`);
}

/**
 * The detail lines that differ between two records of a run: `- line` for one that went, `+ line` for one that came
 * (a changed count shows as both), the run's name dropped. In file order, went before came.
 */
export function detailDiff(was: readonly string[] = [], now: readonly string[] = []): string[] {
  const a = new Set(was);
  const b = new Set(now);
  const strip = (l: string): string => l.slice(l.indexOf(" ") + 1);
  return [
    ...was.filter((l) => !b.has(l)).map((l) => `- ${strip(l)}`),
    ...now.filter((l) => !a.has(l)).map((l) => `+ ${strip(l)}`),
  ];
}

/** True when the run is at a released generator and a field of its frozen output differs. */
export function changesReleasedOutput(was: string, now: string): boolean {
  const a = parseLine(was).fields;
  const b = parseLine(now).fields;
  if (Number(a.get("gen")) >= OPEN_GENERATOR) return false;
  return a.get("error") !== b.get("error") || FROZEN_FIELDS.some((k) => a.get(k) !== b.get(k));
}
