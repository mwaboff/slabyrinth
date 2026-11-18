import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Palette } from "@slabyrinth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryLogger } from "../../logger";
import { fakeCatalogReader, type CatalogReaderPort } from "../../ports/catalog";
import { recordingEmitter } from "../events";
import { tempDir } from "../testing/helpers";
import { CatalogService, computeChangeReport } from "./catalogService";

const PACK = "d71427a1-5535-4fa7-82d7-4ca1e75edbfd";
const WALL = "11111111-1111-4111-8111-111111111111";
const FLOOR = "22222222-2222-4222-8222-222222222222";
const TORCH = "33333333-3333-4333-8333-333333333333";
const NEW = "44444444-4444-4444-8444-444444444444";

const obj = (Id: string, Name: string, IsDeprecated = false) => ({
  Id,
  Name,
  IsDeprecated,
  Folder: "Dungeon",
  GroupTag: "wall",
  Tags: [],
  ColliderBoundsBound: { m_Center: { x: 0.5, y: 1, z: 0.25 }, m_Extent: { x: 0.5, y: 1, z: 0.25 } },
});

const index = (tiles: unknown[], props: unknown[] = []): string =>
  JSON.stringify({ Name: "Medieval Fantasy", Tiles: tiles, Props: props });

const palette: Palette = {
  schema: "slabyrinth/palette@1",
  id: "stone_dungeon",
  name: "Stone dungeon",
  defaults: { floor: "flagstone", wallStyle: "stone" },
  roles: {
    "wall.stone": {
      variants: [
        {
          asset: WALL,
          geom: {
            size: { x: 1, y: 2, z: 0.5 },
            originAt: "minCorner",
            boundsCenter: { x: 0.5, y: 1, z: 0.25 },
          },
        },
      ],
      fallback: "wall.wall",
    },
    "feature.torch_wall": {
      variants: [
        {
          asset: TORCH,
          geom: { size: { x: 0.2, y: 0.5, z: 0.2 }, originAt: "center", boundsCenter: { x: 0, y: 0, z: 0 } },
        },
      ],
    },
  },
};

let dir: string;
let install: string;
beforeEach(async () => {
  dir = await tempDir("slab-cat-");
  install = path.join(dir, "TaleSpire");
  await fsp.mkdir(path.join(install, "Taleweaver", PACK), { recursive: true });
  await fsp.mkdir(path.join(install, "Taleweaver", "Tutorials"), { recursive: true });
  await fsp.writeFile(
    path.join(install, "Taleweaver", PACK, "index.json"),
    index([obj(WALL, "Dungeon Wall 01"), obj(FLOOR, "Dungeon Floor")], [obj(TORCH, "Wall Torch")]),
  );
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function countingReader(): CatalogReaderPort & { reads: number } {
  const r = {
    kind: "fake" as const,
    extractorVersion: 0,
    reads: 0,
    readPack: (
      pack: Parameters<CatalogReaderPort["readPack"]>[0],
      files: Parameters<CatalogReaderPort["readPack"]>[1],
    ) => {
      r.reads += 1;
      return fakeCatalogReader.readPack(pack, files);
    },
  };
  return r;
}

function make(opts: { install?: string | null; reader?: CatalogReaderPort | null; suppress?: boolean } = {}) {
  const emit = recordingEmitter();
  const reader = opts.reader === undefined ? countingReader() : opts.reader;
  const service = new CatalogService({
    catalogFile: path.join(dir, "catalog", "catalog.json"),
    reader,
    resolveInstall: () => Promise.resolve(opts.install === undefined ? install : opts.install),
    palettes: () => [palette],
    emit,
    logger: memoryLogger(),
    suppressWarning: () => opts.suppress === true,
  });
  return { service, emit, reader };
}

describe("CatalogService", () => {
  it("no install: non-blocking warning, built-in asset set", async () => {
    const { service, emit } = make({ install: null });
    await service.startup();
    expect(service.status()).toMatchObject({ state: "no_install", usingBuiltInOnly: true, assets: 0 });
    expect(emit.events).toEqual([
      {
        channel: "catalog:warning",
        payload: { kind: "no_install", message: expect.stringContaining("built-in asset set") as unknown },
      },
    ]);
    const quiet = make({ install: null, suppress: true });
    await quiet.service.startup();
    expect(quiet.emit.events).toEqual([]);
  });

  it("first scan builds and caches; a restart with an unchanged install does not re-read", async () => {
    const first = make();
    await first.service.startup();
    expect(first.service.status()).toMatchObject({ state: "fresh", usingBuiltInOnly: false, assets: 3 });
    expect(first.service.current()?.packs).toEqual([
      { packId: PACK, name: "Medieval Fantasy", source: "index-json", tiles: 2, props: 1 },
    ]);

    const second = make();
    await second.service.startup();
    expect(second.service.status().state).toBe("fresh");
    expect((second.reader as ReturnType<typeof countingReader>).reads).toBe(0);

    // mtime-only change (Steam rewrote the file with identical content): hash matches, no re-read.
    const file = path.join(install, "Taleweaver", PACK, "index.json");
    const later = new Date(Date.now() + 60_000);
    await fsp.utimes(file, later, later);
    const report = await second.service.refresh(false);
    expect(report.added).toBe(0);
    expect((second.reader as ReturnType<typeof countingReader>).reads).toBe(0);
  });

  it("a game update is detected, diffed and reported (removed, deprecated, added, palette roles)", async () => {
    const first = make();
    await first.service.startup();
    await fsp.writeFile(
      path.join(install, "Taleweaver", PACK, "index.json"),
      index([obj(FLOOR, "Dungeon Floor"), obj(NEW, "New Wall")], [obj(TORCH, "Wall Torch", true)]),
    );
    const report = await first.service.refresh(false);
    expect(report.added).toBe(1);
    expect(report.removed).toEqual([{ uuid: WALL, name: "Dungeon Wall 01" }]);
    expect(report.newlyDeprecated).toEqual([{ uuid: TORCH, name: "Wall Torch" }]);
    expect(report.affectedPaletteRoles).toEqual([
      { paletteId: "stone_dungeon", role: "wall.stone", uuid: WALL, resolution: "fallback_role" },
      { paletteId: "stone_dungeon", role: "feature.torch_wall", uuid: TORCH, resolution: "dropped" },
    ]);
    expect(first.emit.events.some((e) => e.channel === "catalog:changed")).toBe(true);
    expect(first.service.status().lastReport).toEqual(report);
  });

  it("an unreadable index or a missing reader falls back to the built-in set with a warning", async () => {
    await fsp.writeFile(path.join(install, "Taleweaver", PACK, "index.json"), "{garbage");
    const broken = make();
    await broken.service.startup();
    expect(broken.service.status()).toMatchObject({ state: "error", usingBuiltInOnly: true });
    expect(broken.emit.events[0]).toMatchObject({
      channel: "catalog:warning",
      payload: { kind: "parse_failed" },
    });

    const noReader = make({ reader: null });
    await noReader.service.startup();
    expect(noReader.service.status().state).toBe("error");
  });

  it("computeChangeReport counts everything as added on the first build", () => {
    const r = computeChangeReport(
      null,
      {
        schema: "slabyrinth/asset-catalog@1",
        extractorVersion: 0,
        generatedAt: "",
        fingerprint: { installPath: "", files: [] },
        packs: [],
        assets: [],
      },
      [],
    );
    expect(r).toMatchObject({ previousGeneratedAt: null, added: 0, removed: [] });
  });
});
