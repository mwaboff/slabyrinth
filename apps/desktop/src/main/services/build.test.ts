import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ChunkOptions, PngExportOptions } from "@slabyrinth/core";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_PLAN } from "../engine/recordings";
import { memoryLogger } from "../logger";
import { fakeCompileBackend, type CompileBackend, type CompileInput } from "../ports/compile";
import type { WorkerResponse } from "../workers/protocol";
import { BuildService } from "./buildService";
import { ClipboardService, memoryClipboard } from "./clipboardService";
import { CompileService, type WorkerLike } from "./compileService";
import { ExportService, roomKeyMarkdown } from "./exportService";
import { PaletteService } from "./paletteService";
import { CatalogService } from "./talespire/catalogService";
import { inProcessWorker } from "./testing/inProcessWorker";
import { projectRig, type ProjectRig } from "./testing/helpers";

let rig: ProjectRig | null = null;
afterEach(async () => {
  if (rig) {
    await rig.projects.close({}).catch(() => undefined);
    await fsp.rm(rig.dir, { recursive: true, force: true });
  }
  rig = null;
});

const input: CompileInput = {
  plan: FIXTURE_PLAN,
  options: {},
  palettes: [],
  userPalettes: [],
  orientation: null,
  orientationOverride: null,
  availability: null,
};

describe("CompileService", () => {
  it("runs the compile in a worker with progress events", async () => {
    rig = await projectRig();
    const compiler = new CompileService({
      spawn: () => inProcessWorker(),
      backend: "fake",
      emit: rig.emit,
      logger: memoryLogger(),
    });
    const bundle = await compiler.run(input);
    expect(bundle.chunks.map((c) => c.id)).toEqual(["build-01"]);
    expect(bundle.chunks[0]?.slab.startsWith("NOT-A-REAL-SLAB")).toBe(true);
    expect(rig.emit.events.filter((e) => e.channel === "compile:progress").length).toBeGreaterThan(0);
    expect(compiler.busy).toBe(false);
  });

  it("cancels by terminating the worker; refuses a second concurrent build", async () => {
    rig = await projectRig();
    let worker: ReturnType<typeof inProcessWorker> | null = null;
    const compiler = new CompileService({
      spawn: () => {
        worker = inProcessWorker(null, 50);
        return worker;
      },
      backend: "fake",
      emit: rig.emit,
      logger: memoryLogger(),
    });
    const p = compiler.run(input);
    await expect(compiler.run(input)).rejects.toMatchObject({ code: "busy" });
    compiler.cancel();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    expect((worker as unknown as { terminated: boolean }).terminated).toBe(true);
  });

  it("reports 'unsupported' when the build has no compiler", async () => {
    rig = await projectRig();
    const compiler = new CompileService({
      spawn: () => inProcessWorker(),
      backend: "none",
      emit: rig.emit,
      logger: memoryLogger(),
    });
    await expect(compiler.run(input)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("the real worker_threads entry loads and answers (tsx loader)", async () => {
    try {
      createRequire(import.meta.url).resolve("tsx");
    } catch {
      return;
    }
    const entry = fileURLToPath(new URL("../workers/compile.worker.ts", import.meta.url));
    const worker = new Worker(entry, { execArgv: ["--import", "tsx"] });
    const reply = await new Promise<WorkerResponse>((resolve, reject) => {
      worker.on("message", (m: WorkerResponse) => {
        if (m.type !== "progress") resolve(m);
      });
      worker.on("error", reject);
      worker.postMessage({ type: "estimate", id: 7, backend: "fake", input });
    });
    await worker.terminate();
    expect(reply).toMatchObject({
      type: "estimated",
      id: 7,
      estimate: { totalAssets: fakeCompileBackend.estimate(input).totalAssets },
    });
  }, 30_000);
});

describe("BuildService and ExportService", () => {
  const setup = async (backend?: CompileBackend) => {
    rig = await projectRig();
    const logger = memoryLogger();
    const palettes = new PaletteService({
      userDir: path.join(rig.dir, "palettes"),
      orientationOverride: path.join(rig.dir, "o.json"),
      logger,
      openPath: () => Promise.resolve(""),
    });
    await palettes.load();
    const catalog = new CatalogService({
      catalogFile: path.join(rig.dir, "catalog.json"),
      reader: null,
      resolveInstall: () => Promise.resolve(null),
      palettes: () => [],
      emit: rig.emit,
      logger,
      suppressWarning: () => true,
    });
    const compiler = new CompileService({
      spawn: (): WorkerLike => inProcessWorker(backend ?? null),
      backend: backend ? "core" : "fake",
      emit: rig.emit,
      logger,
    });
    const build = new BuildService({
      projects: rig.projects,
      compiler,
      palettes,
      catalog,
      settings: rig.settings,
      dialogs: rig.dialogs,
      logger,
    });
    const clip = memoryClipboard();
    const exporter = new ExportService({
      projects: rig.projects,
      dialogs: rig.dialogs,
      clipboard: new ClipboardService(clip),
      logger,
      documentsFolder: () => rig?.dir ?? "",
    });
    await rig.projects.create({ name: "Build me" });
    rig.projects.commitVersion({
      plan: FIXTURE_PLAN,
      author: "ai",
      summary: "v1",
      cause: { type: "create" },
    });
    return { r: rig, build, exporter, clip };
  };

  it("records a build (no slab strings in the project), saves a chunk, tracks pasted", async () => {
    const { r, build } = await setup();
    const bundle = await build.run({});
    expect(bundle.planVersion).toBe(1);
    const record = r.projects.snapshot().builds[0];
    expect(record).toMatchObject({
      versionNumber: 1,
      assetSource: "builtin",
      catalogVersion: "builtin",
      settings: { stacking: "stacked", markers: "multi-chunk" },
    });
    expect(record?.levels[0]?.chunks[0]).toMatchObject({
      id: "build-01",
      globalStep: 1,
      limitBytes: 30720,
      pasted: false,
    });
    await r.projects.flush();
    expect(await fsp.readFile(r.projects.filePath as string, "utf8")).not.toContain("NOT-A-REAL-SLAB");

    r.dialogs.next.saveFile = path.join(r.dir, "chunk.txt");
    expect(bundle.buildId).toBe(record?.id);
    expect(await build.saveChunk(record?.id as string, "build-01")).toEqual({
      path: path.join(r.dir, "chunk.txt"),
    });
    expect((await fsp.readFile(path.join(r.dir, "chunk.txt"), "utf8")).trim()).toBe(bundle.chunks[0]?.slab);

    r.projects.setPasted(record?.id as string, "build-01", true);
    expect(r.projects.snapshot().builds[0]?.levels[0]?.chunks[0]).toMatchObject({
      pasted: true,
      copiedAt: expect.any(String) as unknown,
    });
    expect(() => {
      r.projects.setPasted(record?.id as string, "nope", true);
    }).toThrow(/isn't part/);

    // A rebuild marks unchanged chunks.
    await build.run({});
    expect(r.projects.snapshot().builds[1]?.levels[0]?.chunks[0]?.changedSinceBuild).toBe(false);
  });

  it("records the options a build used and re-copies a non-default build after a restart", async () => {
    const seen: ChunkOptions[] = [];
    const recording: CompileBackend = {
      kind: "core",
      estimate: (input, levels) => fakeCompileBackend.estimate(input, levels),
      compile: (input, progress) => {
        seen.push(structuredClone(input.options));
        return fakeCompileBackend.compile(input, progress);
      },
    };
    const { r, build } = await setup(recording);
    const options: ChunkOptions = { grouping: "per-level", fill: 0.6, levels: ["l1"], tileCells: 24 };
    const res = await build.run({ options });
    const record = r.projects.snapshot().builds[0];
    expect(record?.settings).toMatchObject({
      grouping: "per-level",
      fill: 0.6,
      levels: ["l1"],
      tileCells: 24,
    });
    // Restart: no bundle in memory; the slab is recompiled with exactly the recorded options.
    (build as unknown as { bundles: Map<string, unknown> }).bundles.clear();
    const slab = await build.chunkSlab(res.buildId, res.chunks[0]?.id ?? "");
    expect(slab).toBe(res.chunks[0]?.slab);
    expect(seen[1]).toEqual({ ...seen[0], sideBySideGap: 10 }); // the recorded default gap
  });

  it("records chunks that span several levels once, in paste order, and tracks copies", async () => {
    const twoLevels = {
      ...FIXTURE_PLAN,
      levels: [
        ...FIXTURE_PLAN.levels,
        {
          ...(FIXTURE_PLAN.levels[0] as (typeof FIXTURE_PLAN.levels)[number]),
          id: "l2",
          name: "Up",
          elevation: 2.5,
        },
      ],
    };
    // A split build: chunk 1 holds all of l1 plus part of l2 (core reports levelIds), chunk 2 the rest of l2.
    const spanning: CompileBackend = {
      kind: "core",
      estimate: (input, levels) => fakeCompileBackend.estimate(input, levels),
      compile: (input, progress) => {
        const base = fakeCompileBackend.compile({ ...input, plan: twoLevels }, progress);
        const c0 = base.chunks[0] as (typeof base.chunks)[number];
        return {
          ...base,
          chunks: [
            {
              ...c0,
              id: "map-01",
              levelId: "l1",
              levelIds: ["l1", "l2"],
              index: 1,
              countInLevel: 2,
              contentHash: "a",
            },
            {
              ...c0,
              id: "map-02",
              levelId: "l2",
              levelIds: ["l2"],
              index: 2,
              countInLevel: 2,
              contentHash: "b",
            },
          ],
          levelPlacement: [
            { levelId: "l1", pasteOrder: 1, kind: "ground" },
            { levelId: "l2", pasteOrder: 2, kind: "storeys-up", storeys: 1 },
          ],
        };
      },
    };
    const { r, build } = await setup(spanning);
    const res = await build.run({});
    const record = r.projects.snapshot().builds[0];
    const all = record?.levels.flatMap((l) =>
      l.chunks.map((c) => ({ level: l.levelId, id: c.id, step: c.globalStep, levelIds: c.levelIds })),
    );
    expect(all).toEqual([
      { level: "l1", id: "map-01", step: 1, levelIds: ["l1", "l2"] },
      { level: "l2", id: "map-02", step: 2, levelIds: ["l2"] },
    ]);
    expect(r.projects.markCopied(res.buildId, "map-02")).toBe(true);
    expect(r.projects.markCopied(res.buildId, "nope")).toBe(false);
    expect(r.projects.snapshot().builds[0]?.levels[1]?.chunks[0]?.copiedAt).toEqual(expect.any(String));
  });

  it("the default fake build is one slab holding every level", async () => {
    const { r, build } = await setup();
    r.projects.commitVersion({
      plan: {
        ...FIXTURE_PLAN,
        levels: [
          ...FIXTURE_PLAN.levels,
          { ...(FIXTURE_PLAN.levels[0] as (typeof FIXTURE_PLAN.levels)[number]), id: "l2", elevation: 2.5 },
        ],
      },
      author: "ai",
      summary: "v2",
      cause: { type: "create" },
    });
    const res = await build.run({ version: 2 });
    expect(res.chunks).toHaveLength(1);
    const levels = r.projects.snapshot().builds[0]?.levels ?? [];
    expect(levels.map((l) => l.levelId)).toEqual(["l1", "l2"]);
    expect(levels.flatMap((l) => l.chunks)).toHaveLength(1);
  });

  it("saves PNGs through the native dialog and remembers the options", async () => {
    const { r, exporter } = await setup();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
    const options: PngExportOptions = {
      levels: "all",
      pxPerCell: 70,
      display: {
        grid: true,
        roomNumbers: true,
        roomNames: true,
        furniture: true,
        gmLayer: false,
        legend: true,
      },
      mapThemeId: "print",
      keyPanel: false,
      background: "theme",
    };
    expect(
      await exporter.savePng({ suggestedName: "Crypt", files: [{ levelId: "l1", pngBase64: png }], options }),
    ).toBeNull();
    r.dialogs.next.saveFile = path.join(r.dir, "crypt.png");
    expect(
      await exporter.savePng({ suggestedName: "Crypt", files: [{ levelId: "l1", pngBase64: png }], options }),
    ).toEqual({ paths: [path.join(r.dir, "crypt.png")] });
    r.dialogs.next.chooseFolder = r.dir;
    const multi = await exporter.savePng({
      suggestedName: "Crypt",
      files: [
        { levelId: "l1", pngBase64: png },
        { levelId: "l2", pngBase64: png },
      ],
      options,
    });
    expect(multi?.paths.map((p) => path.basename(p))).toEqual(["Crypt-l1.png", "Crypt-l2.png"]);
    expect(r.projects.getProject()?.pngExport).toMatchObject({
      scope: "all",
      pxPerSquare: 70,
      gmLayer: false,
      style: "print",
    });
    await expect(
      exporter.savePng({
        suggestedName: "x",
        files: [{ levelId: "l1", pngBase64: Buffer.from("<svg/>").toString("base64") }],
        options,
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("room key markdown: copy or save", async () => {
    const { r, exporter, clip } = await setup();
    const res = await exporter.roomKeyMarkdown({ copyToClipboard: true });
    expect(clip.last).toBe(res.markdown);
    expect(res.markdown).toContain("### 1. Entry Hall");
    expect(res.markdown).toContain("> A stone coffin rests under a cracked vault.");
    r.dialogs.next.saveFile = path.join(r.dir, "key.md");
    expect((await exporter.roomKeyMarkdown({ copyToClipboard: false })).path).toBe(
      path.join(r.dir, "key.md"),
    );
    expect(roomKeyMarkdown({ ...FIXTURE_PLAN, title: "<script>" })).toContain("# &lt;script&gt;");
  });
});
