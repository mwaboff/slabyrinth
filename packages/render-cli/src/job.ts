/**
 * One render of the `render 3d` command (an input at a seed): build it, frame and draw its shots, and with `--check`
 * and `--compare` measure it and set it beside its other version. A runner holds what every render shares (meshes,
 * catalog, palettes) so a worker thread opens them once.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildPaletteCatalog, loadPalettes, type AssetCatalog } from "@slabyrinth/core";
import {
  SHOT_RULES,
  clusterFindings,
  clusterShot,
  compareFindings,
  contactSheet,
  downscale,
  encodePng,
  frameBox,
  markedPicture,
  pieceLookup,
  planShots,
  renderScene,
  sceneFromBuild,
  sceneFromSlab,
  shownBounds,
  topShot,
  type Camera,
  type Cutaway,
  type Fallback,
  type ObjectPlan,
  type Picture,
  type RenderedImage,
  type Scene,
  type ShotSpec,
} from "@slabyrinth/scene3d";
import { UsageError, flag, has, numbers, type Args } from "./args";
import { checkScene, findingRecord, type ChecksRecord, type FindingRecord } from "./checks";
import { buildPlan, loadPlanFile, variant, type Built, type Input } from "./inputs";
import { openMeshes, type Meshes } from "./meshes";
import type { Io, RenderEnv } from "./render3d";

export interface Job {
  /** Order in the run. */
  n: number;
  input: Input;
  seed: number | undefined;
}

export interface ShotRecord {
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

export interface CompareRecord {
  against: string;
  pieces: { before: number; after: number };
  pictures: string[];
  /** With --check: findings only the second build has, only the first has, and how many both have. */
  findings?: { added: FindingRecord[]; fixed: FindingRecord[]; unchanged: number };
}

export interface RenderRecord {
  input: string;
  kind: Input["kind"];
  plan?: { id: string; title: string; generator: number; seed: number };
  folder: string;
  instances: number;
  meshes: number;
  boxes: number;
  fallbacks: Fallback[];
  buildProblems?: Array<{ severity: string; code: string; message: string }>;
  ms: { build: number; scene: number; shots: number; checks?: number };
  shots: ShotRecord[];
  checks?: ChecksRecord;
  compare?: CompareRecord;
}

export interface JobOutput {
  n: number;
  record: RenderRecord;
  /** The render's first picture, small, for the run sheet. */
  overview: { picture: Picture; caption: string } | null;
}

/** What `--compare` builds the second version as. */
export interface CompareSpec {
  label: string;
  generator?: number;
  seed?: number;
  plan?: Extract<Input, { kind: "plan" }>;
}

export function sizeOf(a: Args): { width: number; height: number } {
  const s = flag(a, "size") ?? "1024x768";
  const m = /^(\d+)x(\d+)$/.exec(s);
  const width = Number(m?.[1]);
  const height = Number(m?.[2]);
  if (!m || width < 16 || height < 16 || width > 8192 || height > 8192)
    throw new UsageError(`--size ${s}: <width>x<height>, 16 to 8192 each`);
  return { width, height };
}

/** `--compare generator:<n> | seed:<n> | <plan file>`. */
export function compareSpec(a: Args, cwd: string, inputs: readonly Input[]): CompareSpec | null {
  const c = flag(a, "compare");
  if (c === undefined) return null;
  if (inputs.some((i) => i.kind !== "plan")) throw new UsageError("--compare: plans only (not a slab)");
  const m = /^(generator|seed):(\d+)$/.exec(c.trim());
  if (m)
    return m[1] === "generator" ? { label: c, generator: Number(m[2]) } : { label: c, seed: Number(m[2]) };
  if (!existsSync(resolve(cwd, c)))
    throw new UsageError(`--compare ${c}: generator:<n>, seed:<n> or a plan file`);
  if (inputs.length !== 1) throw new UsageError("--compare <plan file>: one input only");
  const plan = loadPlanFile(c, cwd);
  if (plan.kind !== "plan") throw new UsageError(`--compare ${c}: not a plan`);
  return { label: c, plan };
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
        id: `camera-${String(i + 1)}`,
        rule: "camera",
        caption: `From bearing ${String(bearingDeg)}°, ${String(elevationDeg)}° up`,
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
    const ortho = has(a, "ortho");
    out.push({
      id: "eye",
      rule: "camera",
      caption: `From (${String(ex)}, ${String(ey)}, ${String(ez)}) toward (${String(tx)}, ${String(ty)}, ${String(tz)})`,
      camera: {
        projection: ortho ? "ortho" : "persp",
        eye: { x: ex, y: ey, z: ez },
        target: { x: tx, y: ty, z: tz },
        fovDeg,
        halfHeight: ortho ? 10 : 1,
      },
      cutaway: cut,
      width: size.width,
      height: size.height,
      targets: [],
    });
  }
  return out;
}

export interface Runner {
  run(job: Job): Promise<JobOutput>;
  meta(): { meshSource: string; note: string; install: string | null; meshStats: unknown };
}

const slash = (p: string): string => p.split("\\").join("/");

export async function openRunner(
  a: Args,
  io: Io,
  env: RenderEnv,
  out: string,
  compare: CompareSpec | null,
): Promise<Runner> {
  const installFlag = flag(a, "install");
  const meshes: Meshes = await openMeshes({
    boxes: has(a, "boxes"),
    installFlag: installFlag === undefined ? undefined : resolve(env.cwd, installFlag),
    appData: env.appData,
    log: io.err,
  });
  io.err(meshes.note);
  const catalog: AssetCatalog | null = meshes.catalog;
  const palettes = buildPaletteCatalog([], null);
  const lookup = pieceLookup(loadPalettes().palettes, catalog);
  const generatorFlag = flag(a, "generator");
  const generator = generatorFlag !== undefined ? Number(generatorFlag) : undefined;
  const check = has(a, "check");
  const picturesFlag = flag(a, "check-pictures");
  const pictures = picturesFlag === undefined ? 12 : Number(picturesFlag);
  if (!Number.isInteger(pictures) || pictures < 0) throw new UsageError("--check-pictures: a whole number");
  const sheets = has(a, "sheet");
  const size = sizeOf(a);

  /** Build a plan (as given, or as the compare spec says) into its scene. */
  const build = async (
    input: Extract<Input, { kind: "plan" }>,
    o: { generator?: number; seed?: number },
  ): Promise<{ built: Built; scene: Scene; plan: ReturnType<typeof variant> }> => {
    const plan = variant(input.plan, o);
    const built = buildPlan(plan, palettes, input.objects);
    const scene = await sceneFromBuild(built.resolved, built.set, lookup, meshes.source);
    return { built, scene, plan };
  };

  return {
    meta: () => ({
      meshSource: meshes.source.label,
      note: meshes.note,
      install: meshes.installPath,
      meshStats: meshes.install?.stats ?? null,
    }),
    async run(job) {
      const { input, seed } = job;
      const tb = performance.now();
      let scene: Scene;
      let built: Built | null = null;
      let base: Pick<RenderRecord, "input" | "kind" | "plan" | "buildProblems">;
      let buildMs = 0;
      if (input.kind === "plan") {
        const r = await build(input, {
          ...(generator !== undefined ? { generator } : {}),
          ...(seed !== undefined ? { seed } : {}),
        });
        built = r.built;
        scene = r.scene;
        buildMs = performance.now() - tb;
        base = {
          input: input.name,
          kind: "plan",
          plan: { id: r.plan.id, title: r.plan.title, generator: r.plan.generator, seed: r.plan.seed },
          buildProblems: built.problems.map((d) => ({
            severity: d.severity,
            code: d.code,
            message: d.message,
          })),
        };
      } else {
        scene = await sceneFromSlab(input.assets, lookup, meshes.source);
        base = { input: input.name, kind: "slab" };
      }
      const sceneMs = performance.now() - tb - buildMs;
      const folder = join(out, input.name, ...(base.plan ? [`s${String(base.plan.seed)}`] : []));
      const rel = slash(relative(out, folder));
      mkdirSync(folder, { recursive: true });
      const shots: ShotRecord[] = [];
      const tiles: Array<{ picture: Picture; caption: string }> = [];
      const drawn: Array<{ spec: ShotSpec; img: RenderedImage }> = [];
      let overview: JobOutput["overview"] = null;
      const ts = performance.now();
      const specs = shotsFor(scene, a);
      for (const spec of specs) {
        const t = performance.now();
        const img = renderScene(scene, spec);
        const file = join(folder, `${spec.id}.png`);
        writeFileSync(file, encodePng(img));
        if (compare) drawn.push({ spec, img });
        if (sheets) {
          tiles.push({
            picture: downscale(img, Math.ceil(img.width / 512)),
            caption: `${spec.id}: ${spec.caption}`,
          });
          if (!overview)
            overview = {
              picture: downscale(img, Math.ceil(img.width / 384)),
              caption: `${input.name}${base.plan ? ` s${String(base.plan.seed)}` : ""}`,
            };
        }
        shots.push({
          id: spec.id,
          file: slash(relative(out, file)),
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
      const shotsMs = performance.now() - ts;
      const boxes = scene.instances.filter((i) => i.stand === "box").length;
      const record: RenderRecord = {
        ...base,
        folder: rel,
        instances: scene.instances.length,
        meshes: scene.instances.length - boxes,
        boxes,
        fallbacks: scene.fallbacks,
        ms: { build: Math.round(buildMs), scene: Math.round(sceneMs), shots: Math.round(shotsMs) },
        shots,
      };
      const objects: ObjectPlan[] = built?.objects ?? [];
      let findings: ReturnType<typeof checkScene>["findings"] = [];
      if (check) {
        const tc = performance.now();
        const c = checkScene(scene, built?.resolved ?? null, objects, { folder, rel, pictures, size });
        record.checks = c.record;
        findings = c.findings;
        record.ms.checks = Math.round(performance.now() - tc);
      }
      if (compare && input.kind === "plan" && base.plan) {
        const other = compare.plan ?? input;
        const r = await build(other, {
          ...(compare.generator !== undefined
            ? { generator: compare.generator }
            : generator !== undefined
              ? { generator }
              : {}),
          ...(compare.seed !== undefined ? { seed: compare.seed } : seed !== undefined ? { seed } : {}),
        });
        const pics: string[] = [];
        for (const { spec, img } of drawn) {
          const after = renderScene(r.scene, spec);
          const sheet = contactSheet([
            { picture: downscale(img, Math.ceil(img.width / 512)), caption: `before: ${spec.id}` },
            {
              picture: downscale(after, Math.ceil(after.width / 512)),
              caption: `after (${compare.label}): ${spec.id}`,
            },
          ]);
          const file = join(folder, `compare-${spec.id}.png`);
          writeFileSync(file, encodePng(sheet));
          pics.push(slash(relative(out, file)));
        }
        record.compare = {
          against: compare.label,
          pieces: { before: scene.instances.length, after: r.scene.instances.length },
          pictures: pics,
        };
        if (check) {
          const c = checkScene(r.scene, r.built.resolved, r.built.objects, {
            folder,
            rel,
            pictures: 0,
            size,
          });
          const d = compareFindings(findings, c.findings);
          const added = d.added.map(findingRecord);
          clusterFindings(d.added, pictures).forEach((cl, k) => {
            const spec = { ...clusterShot(r.scene, d.added, cl, k + 1, size) };
            spec.id = `after-finding-${String(k + 1)}`;
            writeFileSync(
              join(folder, `${spec.id}.png`),
              encodePng(markedPicture(r.scene, d.added, cl, spec)),
            );
            for (const i of cl.findings) {
              const f = added[i];
              if (f) f.picture = `${rel}/${spec.id}.png`;
            }
          });
          record.compare.findings = { added, fixed: d.fixed.map(findingRecord), unchanged: d.unchanged };
        }
      }
      const seedText = base.plan ? ` seed ${String(base.plan.seed)}` : "";
      io.err(
        `${input.name}${seedText}: ${String(scene.instances.length)} pieces, ${String(boxes)} as boxes (${String(scene.fallbacks.length)} kinds); ${String(shots.length)} picture(s)${record.checks ? `, ${String(record.checks.findings.length)} finding(s)` : ""} in ${String(Math.round(performance.now() - tb))} ms`,
      );
      return { n: job.n, record, overview };
    },
  };
}
