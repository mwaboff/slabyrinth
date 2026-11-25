/**
 * `render 3d`: pictures of a build from its 3D scene. Writes `<out>/<input>/s<seed>/<shot>.png` (a slab:
 * `<out>/<input>/<shot>.png`) and one `index.json` for the run saying what each picture shows and which pieces are
 * boxes and why. `--check` adds the scene checks' findings and a marked picture per cluster of them; `--compare` builds
 * a second version of each input and puts both side by side from the same cameras; `--jobs` runs renders in worker
 * threads. The run's records are in job order whatever the threads do, so the output does not depend on them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { contactSheet, encodePng } from "@slabyrinth/scene3d";
import { UsageError, flag, has, seedList, type Args } from "./args";
import { findingsTable, summaryTable } from "./checks";
import { runJobsInWorkers } from "./batch";
import { REPO_ROOT, fixtureNames, loadFixture, loadPlanFile, loadSlabFile, type Input } from "./inputs";
import { compareSpec, openRunner, shotOptions, type Job, type JobOutput, type RenderRecord } from "./job";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export const USAGE_3D = `usage: npm run render -- 3d <input> [options]
input (one of):
  --fixture <name>[,<name>…] | all   stored plans (packages/core/test/fixtures/plans, test/unit/gen/fixtures,
                                     and scenes core's tests build in code: harbour)
  --plan <file.json>                 a plan, an exported { format, plan } document, or { plan, objects }
  --slab <file.txt>                  slab text, one chunk per line, all pasted at one origin
options:
  --seed <n> | --seeds 1..4|1,5,9    re-seed the plan (default: its own seed)
  --generator <n>                    build the plan at another generator
  --shots <rules>                    overview, interiors, fronts, levels (the shot rules), top, or all
                                     (default overview,levels); --max-shots <n> keeps the best ranked n
  --sheet                            also a sheet.png per render and a run-sheet.png of every overview
  --camera <bearing>,<elevation>     one more shot from that compass bearing and height angle (repeatable as a;b)
  --eye x,y,z --target x,y,z [--fov 45]   one more shot from an explicit camera (perspective)
  --persp | --ortho                  projection of the preset shots (default ortho)
  --cutaway <level id or index>      for --camera/--eye shots: hide the levels above
  --no-roofs                         for --camera/--eye shots: hide roofs
  --size <w>x<h>                     picture size (default 1024x768)
  --check                            run the scene checks: findings in index.json, a table per render, a summary
                                     for a batch, and finding-<n>.png (each cluster of findings marked);
                                     --check-pictures <n> draws at most n per render (default 12)
  --compare <what>                   also build each input as generator:<n>, seed:<n> or <plan file.json> and write
                                     compare-<shot>.png (before | after, the same cameras) and, with the checks,
                                     the findings that are new, fixed and unchanged
  --jobs <n>                         renders in n worker threads (default 1)
  --boxes                            draw every piece as a box (no install needed)
  --install <folder>                 the TaleSpire folder (default: found as the catalog finds it)
  --out <folder>                     default docs/internal/renders/<input>-<time> (git-ignored)
  --json                             print the run's index.json`;

async function inputsOf(a: Args, cwd: string): Promise<Input[]> {
  const given = ["fixture", "plan", "slab"].filter((k) => has(a, k));
  if (given.length !== 1) throw new UsageError("give exactly one of --fixture, --plan or --slab");
  const fixture = flag(a, "fixture");
  if (fixture !== undefined) {
    const names = fixture === "all" ? fixtureNames() : fixture.split(",").map((s) => s.trim());
    const out: Input[] = [];
    for (const n of names) out.push(await loadFixture(n));
    return out;
  }
  const plan = flag(a, "plan");
  if (plan !== undefined) return [loadPlanFile(plan, cwd)];
  const slab = flag(a, "slab");
  if (slab !== undefined) return [loadSlabFile(slab, cwd)];
  throw new UsageError("give an input");
}

const stamp = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Where the command runs: relative paths are read from `cwd`; the app's catalog is looked for under `appData`. */
export interface RenderEnv {
  cwd: string;
  appData: string | null;
  /** Finds TaleSpire when no --install is given (default: meshes.locateInstall; tests pass one that finds none). */
  locate?: () => Promise<string | null>;
}

export async function render3d(a: Args, io: Io, env: RenderEnv): Promise<number> {
  const cwd = env.cwd;
  const inputs = await inputsOf(a, cwd);
  const seedsFlag = flag(a, "seeds") ?? flag(a, "seed");
  const seeds = seedsFlag !== undefined ? seedList(seedsFlag) : [undefined];
  // every option is checked before TaleSpire is looked for or a piece is read: a usage error costs nothing
  const jobsFlag = flag(a, "jobs");
  const threads = jobsFlag === undefined ? 1 : Number(jobsFlag);
  if (!Number.isInteger(threads) || threads < 1 || threads > 64) throw new UsageError("--jobs: 1 to 64");
  const compare = compareSpec(a, cwd, inputs);
  shotOptions(a);
  const outFlag = flag(a, "out");
  const label = inputs.length === 1 ? (inputs[0]?.name ?? "run") : "batch";
  const out = outFlag
    ? resolve(cwd, outFlag)
    : join(REPO_ROOT, "docs", "internal", "renders", `${label}-${stamp()}`);
  mkdirSync(out, { recursive: true });
  const t0 = performance.now();
  const jobs: Job[] = [];
  for (const input of inputs)
    for (const seed of input.kind === "plan" ? seeds : [undefined])
      jobs.push({ n: jobs.length, input, seed });

  let outputs: JobOutput[];
  let meta: { meshSource: string; note: string; install: string | null; meshStats: unknown };
  if (threads > 1 && jobs.length > 1) {
    // a function cannot go to a worker thread: workers look for TaleSpire themselves (tests pass --boxes or --install)
    const workerEnv: RenderEnv = { cwd: env.cwd, appData: env.appData };
    const r = await runJobsInWorkers(
      jobs,
      Math.min(threads, jobs.length),
      { argv: argvOf(a), env: workerEnv, out },
      io,
    );
    outputs = r.outputs;
    meta = r.meta;
  } else {
    const runner = await openRunner(a, io, env, out, compare);
    outputs = [];
    for (const job of jobs) outputs.push(await runner.run(job));
    meta = runner.meta();
  }
  outputs.sort((p, q) => p.n - q.n);
  const records: RenderRecord[] = outputs.map((o) => o.record);
  const runTiles = outputs.flatMap((o) => (o.overview ? [o.overview] : []));
  if (has(a, "sheet") && runTiles.length > 0)
    writeFileSync(join(out, "run-sheet.png"), encodePng(contactSheet(runTiles, { tileWidth: 384 })));
  const index = {
    tool: "render 3d",
    ...meta,
    ...(compare ? { compare: compare.label } : {}),
    totalMs: Math.round(performance.now() - t0),
    renders: records,
  };
  writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  if (has(a, "check")) {
    for (const r of records)
      if (r.checks)
        io.err(findingsTable(`${r.input}${r.plan ? ` s${String(r.plan.seed)}` : ""}`, r.checks.findings));
    if (records.length > 1)
      io.err(
        "\n" +
          summaryTable(
            records.map((r) => ({
              name: `${r.input}${r.plan && seeds.length > 1 ? ` s${String(r.plan.seed)}` : ""}`,
              findings: r.checks?.findings ?? [],
            })),
          ),
      );
  }
  if (has(a, "json")) io.out(JSON.stringify(index, null, 2));
  else
    io.out(
      `wrote ${String(records.reduce((n, r) => n + r.shots.length, 0))} picture(s) and index.json to ${out}`,
    );
  return 0;
}

/** The command line again (for the worker threads), from the parsed flags. */
function argvOf(a: Args): string[] {
  const out = [...a._];
  for (const [k, v] of a.flags) {
    if (v === true) out.push(`--${k}`);
    else out.push(`--${k}=${v}`);
  }
  return out;
}
