/**
 * `render 3d`: pictures of a build from its 3D scene. Writes `<out>/<input>/s<seed>/<shot>.png` (a slab:
 * `<out>/<input>/<shot>.png`) and one `index.json` for the run saying what each picture shows and which pieces are
 * boxes and why.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildPaletteCatalog, loadPalettes, type AssetCatalog } from "@slabyrinth/core";
import {
  SHOT_RULES,
  contactSheet,
  downscale,
  encodePng,
  frameBox,
  pieceLookup,
  planShots,
  type Picture,
  renderScene,
  sceneFromBuild,
  sceneFromSlab,
  shownBounds,
  topShot,
  type Camera,
  type Cutaway,
  type Fallback,
  type Scene,
  type ShotSpec,
} from "@slabyrinth/scene3d";
import { UsageError, flag, has, numbers, seedList, type Args } from "./args";
import {
  REPO_ROOT,
  buildPlan,
  fixtureNames,
  loadFixture,
  loadPlanFile,
  loadSlabFile,
  variant,
  type Input,
} from "./inputs";
import { openMeshes } from "./meshes";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export const USAGE_3D = `usage: npm run render -- 3d <input> [options]
input (one of):
  --fixture <name>[,<name>…] | all   stored plans (packages/core/test/fixtures/plans, test/unit/gen/fixtures)
  --plan <file.json>                 a plan, or an exported { format, plan } document
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
  --boxes                            draw every piece as a box (no install needed)
  --install <folder>                 the TaleSpire folder (default: found as the catalog finds it)
  --out <folder>                     default docs/internal/renders/<input>-<time> (git-ignored)
  --json                             print the run's index.json`;

interface ShotRecord {
  id: string;
  file: string;
  rule: string;
  caption: string;
  targets: string[];
  camera: Camera;
  cutaway: Cutaway;
  width: number;
  height: number;
  instancesDrawn: number;
  boxesDrawn: number;
  trianglesDrawn: number;
  ms: number;
}

interface RenderRecord {
  input: string;
  kind: Input["kind"];
  plan?: { id: string; title: string; generator: number; seed: number };
  folder: string;
  instances: number;
  meshes: number;
  boxes: number;
  fallbacks: Fallback[];
  buildProblems?: Array<{ severity: string; code: string; message: string }>;
  ms: { build: number; scene: number; shots: number };
  shots: ShotRecord[];
}

function sizeOf(a: Args): { width: number; height: number } {
  const s = flag(a, "size") ?? "1024x768";
  const m = /^(\d+)x(\d+)$/.exec(s);
  const width = Number(m?.[1]);
  const height = Number(m?.[2]);
  if (!m || width < 16 || height < 16 || width > 8192 || height > 8192)
    throw new UsageError(`--size ${s}: <width>x<height>, 16 to 8192 each`);
  return { width, height };
}

function inputsOf(a: Args, cwd: string): Input[] {
  const given = ["fixture", "plan", "slab"].filter((k) => has(a, k));
  if (given.length !== 1) throw new UsageError("give exactly one of --fixture, --plan or --slab");
  const fixture = flag(a, "fixture");
  if (fixture !== undefined)
    return (fixture === "all" ? fixtureNames() : fixture.split(",").map((s) => s.trim())).map(loadFixture);
  const plan = flag(a, "plan");
  if (plan !== undefined) return [loadPlanFile(plan, cwd)];
  const slab = flag(a, "slab");
  if (slab !== undefined) return [loadSlabFile(slab, cwd)];
  throw new UsageError("give an input");
}

/** The shots asked for, framed on the scene. */
function shotsFor(scene: Scene, a: Args): ShotSpec[] {
  const size = { ...sizeOf(a), projection: has(a, "persp") ? ("persp" as const) : ("ortho" as const) };
  const wanted = new Set(
    (flag(a, "shots") ?? "overview,levels")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const known = new Set<string>([...SHOT_RULES, "top", "all"]);
  for (const w of wanted)
    if (!known.has(w)) throw new UsageError(`--shots ${w}: one of ${[...known].join(", ")}`);
  const maxFlag = flag(a, "max-shots");
  const max = maxFlag === undefined ? undefined : Number(maxFlag);
  if (max !== undefined && !(Number.isInteger(max) && max >= 0))
    throw new UsageError("--max-shots: a whole number");
  const rules = SHOT_RULES.filter((r) => wanted.has(r) || wanted.has("all"));
  const out: ShotSpec[] = planShots(scene, { size, rules, ...(max !== undefined ? { max } : {}) });
  if (wanted.has("top") || wanted.has("all")) out.push(topShot(scene, size));
  const cut: Cutaway = {};
  const level = flag(a, "cutaway");
  if (level !== undefined) {
    const l = scene.levels.find((x) => x.id === level || String(x.index) === level);
    if (!l) throw new UsageError(`--cutaway ${level}: one of ${scene.levels.map((x) => x.id).join(", ")}`);
    cut.maxLevelIndex = l.index;
  }
  if (has(a, "no-roofs")) cut.hideLayers = ["roof"];
  const cam = flag(a, "camera");
  if (cam !== undefined)
    cam.split(";").forEach((c, i) => {
      const [bearingDeg = 0, elevationDeg = 0] = numbers(c, 2, "--camera");
      const camera = frameBox(shownBounds(scene, cut), { bearingDeg, elevationDeg, ...size });
      out.push({
        id: `camera-${i + 1}`,
        rule: "camera",
        caption: `From bearing ${bearingDeg}°, ${elevationDeg}° up`,
        camera,
        cutaway: cut,
        width: size.width,
        height: size.height,
        targets: [],
      });
    });
  const eye = flag(a, "eye");
  const target = flag(a, "target");
  if ((eye === undefined) !== (target === undefined)) throw new UsageError("--eye and --target go together");
  if (eye !== undefined && target !== undefined) {
    const [ex = 0, ey = 0, ez = 0] = numbers(eye, 3, "--eye");
    const [tx = 0, ty = 0, tz = 0] = numbers(target, 3, "--target");
    const fovDeg = Number(flag(a, "fov") ?? 45);
    if (!(fovDeg > 1 && fovDeg < 170)) throw new UsageError("--fov: degrees between 1 and 170");
    out.push({
      id: "eye",
      rule: "camera",
      caption: `From (${ex}, ${ey}, ${ez}) toward (${tx}, ${ty}, ${tz})`,
      camera: has(a, "ortho")
        ? {
            projection: "ortho",
            eye: { x: ex, y: ey, z: ez },
            target: { x: tx, y: ty, z: tz },
            fovDeg,
            halfHeight: 10,
          }
        : {
            projection: "persp",
            eye: { x: ex, y: ey, z: ez },
            target: { x: tx, y: ty, z: tz },
            fovDeg,
            halfHeight: 1,
          },
      cutaway: cut,
      width: size.width,
      height: size.height,
      targets: [],
    });
  }
  return out;
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
}

export async function render3d(a: Args, io: Io, env: RenderEnv): Promise<number> {
  const cwd = env.cwd;
  const inputs = inputsOf(a, cwd);
  const seedsFlag = flag(a, "seeds") ?? flag(a, "seed");
  const seeds = seedsFlag !== undefined ? seedList(seedsFlag) : [undefined];
  const generatorFlag = flag(a, "generator");
  const generator = generatorFlag !== undefined ? Number(generatorFlag) : undefined;
  const outFlag = flag(a, "out");
  const label = inputs.length === 1 ? (inputs[0]?.name ?? "run") : "batch";
  const out = outFlag
    ? resolve(cwd, outFlag)
    : join(REPO_ROOT, "docs", "internal", "renders", `${label}-${stamp()}`);
  const t0 = performance.now();
  const installFlag = flag(a, "install");
  const meshes = await openMeshes({
    boxes: has(a, "boxes"),
    installFlag: installFlag === undefined ? undefined : resolve(cwd, installFlag),
    appData: env.appData,
    log: io.err,
  });
  io.err(meshes.note);
  const catalog: AssetCatalog | null = meshes.catalog;
  const palettes = buildPaletteCatalog([], null);
  const lookup = pieceLookup(loadPalettes().palettes, catalog);
  const records: RenderRecord[] = [];
  const sheets = has(a, "sheet");
  const runTiles: Array<{ picture: Picture; caption: string }> = [];
  for (const input of inputs)
    for (const seed of input.kind === "plan" ? seeds : [undefined]) {
      const tb = performance.now();
      let scene: Scene;
      let record: Omit<
        RenderRecord,
        "folder" | "instances" | "meshes" | "boxes" | "fallbacks" | "ms" | "shots"
      >;
      let buildMs = 0;
      if (input.kind === "plan") {
        const plan = variant(input.plan, {
          ...(generator !== undefined ? { generator } : {}),
          ...(seed !== undefined ? { seed } : {}),
        });
        const built = buildPlan(plan, palettes);
        buildMs = performance.now() - tb;
        scene = await sceneFromBuild(built.resolved, built.set, lookup, meshes.source);
        record = {
          input: input.name,
          kind: "plan",
          plan: { id: plan.id, title: plan.title, generator: plan.generator, seed: plan.seed },
          buildProblems: built.problems.map((d) => ({
            severity: d.severity,
            code: d.code,
            message: d.message,
          })),
        };
      } else {
        scene = await sceneFromSlab(input.assets, lookup, meshes.source);
        record = { input: input.name, kind: "slab" };
      }
      const sceneMs = performance.now() - tb - buildMs;
      const folder = join(out, input.name, ...(record.plan ? [`s${record.plan.seed}`] : []));
      mkdirSync(folder, { recursive: true });
      const shots: ShotRecord[] = [];
      const tiles: Array<{ picture: Picture; caption: string }> = [];
      const ts = performance.now();
      for (const spec of shotsFor(scene, a)) {
        const t = performance.now();
        const img = renderScene(scene, spec);
        const file = join(folder, `${spec.id}.png`);
        writeFileSync(file, encodePng(img));
        if (sheets) {
          tiles.push({
            picture: downscale(img, Math.ceil(img.width / 512)),
            caption: `${spec.id}: ${spec.caption}`,
          });
          if (tiles.length === 1)
            runTiles.push({
              picture: downscale(img, Math.ceil(img.width / 384)),
              caption: `${input.name}${record.plan ? ` s${record.plan.seed}` : ""}`,
            });
        }
        shots.push({
          id: spec.id,
          file: relative(out, file).split("\\").join("/"),
          rule: spec.rule,
          caption: spec.caption,
          targets: spec.targets,
          camera: spec.camera,
          cutaway: spec.cutaway,
          width: img.width,
          height: img.height,
          ...img.stats,
          ms: Math.round(performance.now() - t),
        });
      }
      if (sheets && tiles.length > 0)
        writeFileSync(join(folder, "sheet.png"), encodePng(contactSheet(tiles)));
      const boxes = scene.instances.filter((i) => i.stand === "box").length;
      records.push({
        ...record,
        folder: relative(out, folder).split("\\").join("/"),
        instances: scene.instances.length,
        meshes: scene.instances.length - boxes,
        boxes,
        fallbacks: scene.fallbacks,
        ms: {
          build: Math.round(buildMs),
          scene: Math.round(sceneMs),
          shots: Math.round(performance.now() - ts),
        },
        shots,
      });
      const seedText = record.plan ? ` seed ${record.plan.seed}` : "";
      io.err(
        `${input.name}${seedText}: ${scene.instances.length} pieces, ${boxes} as boxes (${scene.fallbacks.length} kinds); ${shots.length} picture(s) in ${Math.round(performance.now() - tb)} ms`,
      );
    }
  if (sheets && runTiles.length > 0)
    writeFileSync(join(out, "run-sheet.png"), encodePng(contactSheet(runTiles, { tileWidth: 384 })));
  const index = {
    tool: "render 3d",
    meshSource: meshes.source.label,
    note: meshes.note,
    install: meshes.installPath,
    meshStats: meshes.install?.stats ?? null,
    totalMs: Math.round(performance.now() - t0),
    renders: records,
  };
  writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  if (has(a, "json")) io.out(JSON.stringify(index, null, 2));
  else io.out(`wrote ${records.reduce((n, r) => n + r.shots.length, 0)} picture(s) and index.json to ${out}`);
  return 0;
}
