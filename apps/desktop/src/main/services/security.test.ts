import { createWriteStream } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_PLAN } from "../fixturePlan";
import { createHandlers, type HandlerServices } from "../ipc/handlers";
import { createDispatcher } from "../ipc/router";
import { requestSchemas } from "../../shared/schemas/ipc";
import { settingsPatchSchema } from "../../shared/schemas/settings";
import { memoryLogger } from "../logger";
import { checkLocalPath } from "../util/safePath";
import { SettingsStore } from "./settingsStore";
import { projectRig, scriptedDialogs, tempDir, type ProjectRig } from "./testing/helpers";

/** Review findings: key redirection, renderer-supplied paths, gzip bombs, half-applied head moves, races. */
let rig: ProjectRig | null = null;
afterEach(async () => {
  if (rig) {
    await rig.projects.close({}).catch(() => undefined);
    await fsp.rm(rig.dir, { recursive: true, force: true });
  }
  rig = null;
});

describe("HIGH 1: the API key can't be redirected to another host", () => {
  it("settings:update rejects a baseUrl for anthropic; LM Studio (keyless) may set one", () => {
    expect(
      settingsPatchSchema.safeParse({ providers: { anthropic: { baseUrl: "https://evil.example/v1" } } })
        .success,
    ).toBe(false);
    expect(settingsPatchSchema.safeParse({ providers: { anthropic: { enabled: true } } }).success).toBe(true);
    expect(
      settingsPatchSchema.safeParse({ providers: { lmstudio: { baseUrl: "http://localhost:1234/v1" } } })
        .success,
    ).toBe(true);
  });

  it("through the IPC router the rejection is a visible 'validation' error", async () => {
    const d = createDispatcher(
      { "settings:update": () => ({}) } as never,
      requestSchemas,
      () => true,
      memoryLogger(),
    );
    const r = await d("settings:update", "file:///x", {
      providers: { anthropic: { baseUrl: "https://evil.example" } },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("a settings file on disk with an anthropic baseUrl loads with it dropped", async () => {
    const dir = await tempDir("slab-sec-");
    const file = path.join(dir, "settings.json");
    await fsp.writeFile(
      file,
      JSON.stringify({
        providers: {
          anthropic: { enabled: true, baseUrl: "https://evil.example" },
          lmstudio: { enabled: false, baseUrl: "http://localhost:9999/v1" },
        },
      }),
    );
    const store = new SettingsStore({ file, defaultProjectsFolder: dir, logger: memoryLogger() });
    const s = await store.load();
    expect(s.providers["anthropic"].baseUrl).toBeUndefined();
    expect(s.providers["lmstudio"].baseUrl).toBe("http://localhost:9999/v1");
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe("HIGH 2: renderer-supplied paths", () => {
  it("checkLocalPath rejects UNC, device, relative, traversal, non-normalised and wrong-extension paths", () => {
    const win = (p: string): unknown => checkLocalPath(p, { ext: ".slabyrinth", platform: "win32" });
    const nix = (p: string): unknown => checkLocalPath(p, { ext: ".slabyrinth", platform: "linux" });
    expect(win("C:\\Users\\gm\\Documents\\Slabyrinth\\Crypt.slabyrinth")).toBe(
      "C:\\Users\\gm\\Documents\\Slabyrinth\\Crypt.slabyrinth",
    );
    expect(nix("/home/gm/Documents/Slabyrinth/Crypt.slabyrinth")).toBe(
      "/home/gm/Documents/Slabyrinth/Crypt.slabyrinth",
    );
    for (const bad of [
      "\\\\server\\share\\a.slabyrinth", // UNC
      "//server/share/a.slabyrinth",
      "\\\\?\\C:\\a.slabyrinth", // device
      "\\\\.\\PhysicalDrive0",
      "C:\\Windows\\NUL.slabyrinth", // device name
      "C:\\a.slabyrinth:stream", // ADS
      "Projects\\a.slabyrinth", // relative
      "\\a.slabyrinth", // drive-relative
      "C:\\Users\\..\\Windows\\a.slabyrinth", // traversal
      "C:\\Users\\.\\a.slabyrinth",
      "C:\\Users\\\\a.slabyrinth", // not normalised
      "C:\\Users\\gm\\notes.txt", // wrong extension
    ]) {
      expect(() => win(bad), bad).toThrow(expect.objectContaining({ code: "validation" }) as Error);
    }
    for (const bad of [
      "a.slabyrinth",
      "/home/../etc/a.slabyrinth",
      "/home/gm/x.json",
      "//host/a.slabyrinth",
    ]) {
      expect(() => nix(bad), bad).toThrow(expect.objectContaining({ code: "validation" }) as Error);
    }
  });

  it("open/duplicate/trash/reveal accept only project paths main handed out, and touch nothing otherwise", async () => {
    rig = await projectRig();
    const snap = await rig.projects.create({ name: "Mine" });
    const mine = snap.filePath as string;
    // A real project file main never listed (e.g. elsewhere on disk).
    const stranger = path.join(rig.dir, "elsewhere", "Other.slabyrinth");
    await fsp.mkdir(path.dirname(stranger), { recursive: true });
    await fsp.copyFile(mine, stranger);
    const unknownPaths = [
      stranger,
      path.join(rig.dir, "Projects", "Missing.slabyrinth"),
      path.join(rig.dir, "Projects", "..", "elsewhere", "Other.slabyrinth"), // traversal
      "Projects/Mine.slabyrinth", // relative
      path.join(rig.dir, "settings.json"), // wrong extension
      "\\\\server\\share\\Mine.slabyrinth", // UNC
    ];
    for (const p of unknownPaths) {
      await expect(rig.projects.open({ path: p }), p).rejects.toMatchObject({ code: "validation" });
      await expect(rig.projects.duplicate(p), p).rejects.toMatchObject({ code: "validation" });
      await expect(rig.projects.trash(p), p).rejects.toMatchObject({ code: "validation" });
      expect(() => {
        rig?.projects.revealInFolder(p);
      }, p).toThrow(expect.objectContaining({ code: "validation" }) as Error);
    }
    expect(fs.existsSync(stranger)).toBe(true);
    expect(fs.existsSync(path.join(rig.dir, "settings.json"))).toBe(true);
    expect(rig.trashed).toEqual([]);
    // The project main created is accepted; after project:list, listed files are too.
    await expect(rig.projects.duplicate(mine)).resolves.toMatchObject({
      path: expect.stringContaining("Mine (copy)") as unknown,
    });
  });

  it("trash deletes only the accepted file and its .bak sibling", async () => {
    rig = await projectRig();
    const a = (await rig.projects.create({ name: "A" })).filePath as string;
    rig.projects.updateBrief({ tone: "x" });
    await rig.projects.flush(); // creates A.slabyrinth.bak
    const b = (await rig.projects.create({ name: "B" })).filePath as string;
    await rig.projects.close({});
    await fsp.writeFile(`${a}.notes.txt`, "keep me");
    expect(fs.existsSync(`${a}.bak`)).toBe(true);
    await rig.projects.trash(a);
    expect(rig.trashed).toEqual([a]);
    expect(fs.existsSync(`${a}.bak`)).toBe(false);
    expect(fs.existsSync(`${a}.notes.txt`)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
  });

  it("folder paths (talespire:setPath, projects folder) must come from the folder picker or talespire:locate", async () => {
    const dir = await tempDir("slab-sec-");
    const settings = new SettingsStore({
      file: path.join(dir, "settings.json"),
      defaultProjectsFolder: path.join(dir, "Projects"),
      logger: memoryLogger(),
    });
    await settings.load();
    const dialogs = scriptedDialogs();
    const setPaths: Array<string | null> = [];
    const handlers = createHandlers({
      settings,
      dialogs,
      logger: memoryLogger(),
      talespire: {
        setPath: (p: string | null) => {
          setPaths.push(p);
          return Promise.resolve({ valid: true });
        },
        locate: () =>
          Promise.resolve({
            found: [{ path: path.join(dir, "Steam", "TaleSpire"), source: "steam" as const }],
          }),
        checkInstall: (p: string) => Promise.resolve({ path: p, valid: true as const }),
      },
      catalog: { refresh: () => Promise.resolve({}), watch: () => Promise.resolve() },
    } as unknown as HandlerServices);
    const picked = path.join(dir, "Picked");
    await expect(handlers["talespire:setPath"]({ path: path.join(dir, "Random") })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(handlers["talespire:setPath"]({ path: "\\\\server\\TaleSpire" })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      handlers["settings:update"]({ projects: { folder: picked } } as never),
    ).rejects.toMatchObject({
      code: "validation",
    });
    expect(setPaths).toEqual([]);
    dialogs.next.chooseFolder = picked;
    await handlers["dialog:pickFolder"]({ purpose: "projects" });
    await expect(
      handlers["settings:update"]({ projects: { folder: picked } } as never),
    ).resolves.toMatchObject({
      projects: { folder: picked },
    });
    await handlers["talespire:locate"](undefined);
    await handlers["talespire:setPath"]({ path: path.join(dir, "Steam", "TaleSpire") });
    await handlers["talespire:setPath"]({ path: null });
    expect(setPaths).toEqual([path.join(dir, "Steam", "TaleSpire"), null]);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe("MEDIUM 4: oversized and gzip-bomb project files", () => {
  it("a gzip bomb and an oversized file are listed as unreadable and refused on open, without crashing", async () => {
    rig = await projectRig();
    const folder = path.join(rig.dir, "Projects");
    await fsp.mkdir(folder, { recursive: true });
    const bomb = path.join(folder, "Bomb.slabyrinth");
    // 260 MB of zeros gzip to ~250 KB on disk; inflating them must stop at the 256 MB cap.
    const zeros = Buffer.alloc(1024 * 1024);
    await pipeline(
      Readable.from(
        (function* () {
          for (let i = 0; i < 260; i++) yield zeros;
        })(),
      ),
      createGzip({ level: 1 }),
      createWriteStream(bomb),
    );
    const huge = path.join(folder, "Huge.slabyrinth");
    await fsp.writeFile(huge, "");
    await fsp.truncate(huge, 65 * 1024 * 1024);

    const list = await rig.projects.list();
    for (const name of ["Bomb", "Huge"]) {
      expect(list.find((e) => e.name === name)).toMatchObject({ exists: true, levels: 0, rooms: 0 });
    }
    const warns = rig.logger.records.filter((r) => r.msg === "project unreadable in list").length;
    await rig.projects.list(); // unchanged files are not parsed again
    expect(rig.logger.records.filter((r) => r.msg === "project unreadable in list").length).toBe(warns);
    await expect(rig.projects.open({ path: bomb })).rejects.toMatchObject({ code: "validation" });
    await expect(rig.projects.open({ path: huge })).rejects.toMatchObject({ code: "validation" });
  }, 60_000);
});

describe("LOW 6/7/8: head moves, rename and lifecycle races", () => {
  it("undo whose target version can't be replayed changes nothing", async () => {
    rig = await projectRig();
    const file = (await rig.projects.create({ name: "Replay" })).filePath as string;
    rig.projects.commitVersion({
      plan: FIXTURE_PLAN,
      author: "ai",
      summary: "v1",
      cause: { type: "create" },
    });
    rig.projects.applyOps({
      baseVersion: 1,
      label: "brazier",
      ops: [{ op: "add_features", level: "l1", features: [{ id: "b1", type: "brazier", at: [3, 5] }] }],
    });
    rig.projects.restore(1); // v3: keyframe, parent v2
    await rig.projects.close({});
    // Corrupt v2's ops on disk so replaying it fails, then reopen (fresh replay cache).
    const json = JSON.parse(await fsp.readFile(file, "utf8")) as {
      history: { versions: Array<{ number: number; cause: { ops?: unknown[] } }> };
    };
    const v2 = json.history.versions.find((v) => v.number === 2);
    if (v2) v2.cause.ops = [{ op: "update", id: "no_such_element", set: { name: "x" } }];
    await fsp.writeFile(file, JSON.stringify(json));
    await rig.projects.open({ path: file });
    const before = rig.projects.snapshot();
    expect(before.head).toBe(3);
    expect(() => rig?.projects.undo()).toThrow();
    const after = rig.projects.snapshot();
    expect(after.head).toBe(3);
    expect(after.undone).toEqual(before.undone);
    expect(after.plan).toEqual(before.plan);
  });

  it("rename moves the file inside the write chain: a concurrent flush never recreates the old file", async () => {
    rig = await projectRig({ autosaveDelayMs: 1 });
    const old = (await rig.projects.create({ name: "Before" })).filePath as string;
    rig.projects.updateBrief({ tone: "a" });
    const renaming = rig.projects.rename("After");
    rig.projects.updateBrief({ tone: "b" });
    const flushing = rig.projects.flush();
    await Promise.all([renaming, flushing]);
    rig.projects.updateBrief({ tone: "c" });
    await rig.projects.flush();
    expect(fs.existsSync(old)).toBe(false);
    expect(rig.projects.filePath).toBe(path.join(path.dirname(old), "After.slabyrinth"));
    expect(fs.existsSync(rig.projects.filePath as string)).toBe(true);
  });

  it("rename is refused while a turn runs", async () => {
    rig = await projectRig();
    await rig.projects.create({ name: "Busy" });
    rig.projects.setBusy({ turnId: "t" });
    await expect(rig.projects.rename("Other")).rejects.toMatchObject({ code: "busy" });
  });

  it("concurrent project:new calls never leak a lock", async () => {
    rig = await projectRig();
    await Promise.all([
      rig.projects.create({ name: "One" }),
      rig.projects.create({ name: "Two" }),
      rig.projects.create({ name: "Three" }),
    ]);
    const locks = (await fsp.readdir(path.join(rig.dir, "Projects"))).filter((n) => n.endsWith(".lock"));
    expect(locks).toEqual([`${path.basename(rig.projects.filePath as string)}.lock`]);
  });
});
