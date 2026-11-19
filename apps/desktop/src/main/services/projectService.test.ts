import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_PLAN } from "../engine/recordings";
import { corePort, projectRig, type ProjectRig } from "./testing/helpers";
import { sanitizeFileName } from "./projectService";

let rig: ProjectRig | null = null;
afterEach(async () => {
  if (rig) {
    await rig.projects.close({}).catch(() => undefined);
    await fsp.rm(rig.dir, { recursive: true, force: true });
  }
  rig = null;
});

const read = async (f: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fsp.readFile(f, "utf8")) as Record<string, unknown>;

describe("ProjectService: files", () => {
  it("creates a project file in the projects folder, locks it, and lists it as recent", async () => {
    rig = await projectRig();
    const snap = await rig.projects.create({ name: "The Drowned Abbey" });
    expect(snap.filePath).toBe(path.join(rig.dir, "Projects", "The Drowned Abbey.slabyrinth"));
    expect(snap.conversation.phase).toBe("brief");
    expect(snap.dirty).toBe(false);
    expect(fs.existsSync(`${snap.filePath as string}.lock`)).toBe(true);
    const file = await read(snap.filePath as string);
    expect(file["format"]).toBe("slabyrinth/project@1");
    expect(JSON.stringify(file)).not.toMatch(/apiKey|sk-ant/);
    expect(rig.settings.get().projects.recent[0]).toBe(snap.filePath);
    // A second project with the same name gets a unique file.
    const second = await rig.projects.create({ name: "The Drowned Abbey" });
    expect(second.filePath).toBe(path.join(rig.dir, "Projects", "The Drowned Abbey 2.slabyrinth"));
    expect(fs.existsSync(`${snap.filePath as string}.lock`)).toBe(false); // first one was closed
  });

  it("boot → create → change → close → reopen restores the same state", async () => {
    rig = await projectRig();
    const snap = await rig.projects.create({ name: "Resume me" });
    rig.projects.commitVersion({
      plan: FIXTURE_PLAN,
      author: "ai",
      summary: "First draft",
      cause: { type: "create" },
    });
    rig.projects.updateBrief({ tone: "grim" });
    const png = {
      scope: "all" as const,
      style: "print",
      pxPerSquare: 70,
      grid: true,
      numbers: true,
      names: false,
      gmLayer: false,
      keyPanel: true,
    };
    rig.projects.setUiState({
      ui: { tab: "build", levelId: "l1", zoom: 2 },
      pasteGuide: { buildId: "b1", currentStep: 2 },
      pngExport: png,
    });
    const conv = snap.conversation.id;
    rig.projects.appendItems(conv, [
      { type: "user", id: "u1", text: "hello", createdAt: new Date().toISOString() },
    ]);
    await rig.projects.close({});
    const reopened = await rig.projects.open({ path: snap.filePath as string });
    expect(reopened?.head).toBe(1);
    expect(reopened?.plan?.title).toBe("The Fake Crypt");
    expect(reopened?.brief.tone).toEqual({ value: "grim", source: "user" });
    expect(reopened?.conversation.items.map((i) => i.id)).toEqual(["u1"]);
    expect(rig.projects.getProject()?.ui).toMatchObject({ tab: "build", levelId: "l1", zoom: 2 });
    // Resume state comes back in the snapshot.
    expect(reopened?.ui).toMatchObject({ tab: "build", levelId: "l1", zoom: 2 });
    expect(reopened?.pasteGuide).toEqual({ buildId: "b1", currentStep: 2 });
    expect(reopened?.pngExport).toEqual(png);
  });

  it("starts a new project's brief with the default game system from settings", async () => {
    rig = await projectRig();
    expect((await rig.projects.create({ name: "No system" })).brief.system).toBeUndefined();
    await rig.settings.update({ defaultSystem: { system: "other", otherName: "Pathfinder 2e" } });
    await rig.settings.update({ defaultSystem: { system: "dnd5e" } });
    expect(rig.settings.get().defaultSystem).toEqual({ system: "dnd5e" }); // replaced whole, not merged
    expect((await rig.projects.create({ name: "5e" })).brief.system).toEqual({
      value: "dnd5e",
      source: "user",
    });
  });

  it("autosaves after the debounce and reports dirty → clean", async () => {
    rig = await projectRig({ autosaveDelayMs: 30 });
    const snap = await rig.projects.create({ name: "Autosave" });
    rig.projects.updateBrief({ tone: "eerie" });
    expect(rig.projects.snapshot().dirty).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    await rig.projects.flush();
    expect(rig.projects.snapshot().dirty).toBe(false);
    const file = await read(snap.filePath as string);
    expect((file["brief"] as Record<string, unknown>)["tone"]).toEqual({ value: "eerie", source: "user" });
    const changes = rig.emit.events
      .filter((e) => e.channel === "project:changed")
      .map((e) => (e.payload as { dirty: boolean }).dirty);
    expect(changes).toContain(true);
    expect(changes[changes.length - 1]).toBe(false);
  });

  it("refuses a newer format and non-project files", async () => {
    rig = await projectRig();
    const newer = path.join(rig.dir, "newer.slabyrinth");
    await fsp.writeFile(newer, JSON.stringify({ format: "slabyrinth/project@1", formatVersion: 99 }));
    rig.dialogs.next.openFile = newer; // picked in the native open dialog
    await expect(rig.projects.open({})).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("newer version") as unknown,
    });
    const junk = path.join(rig.dir, "junk.slabyrinth");
    await fsp.writeFile(junk, JSON.stringify({ hello: 1 }));
    rig.dialogs.next.openFile = junk;
    await expect(rig.projects.open({})).rejects.toMatchObject({
      message: "That file isn't a Slabyrinth project.",
    });
  });

  it("refuses a map from a newer app version with a plain message and leaves the file untouched", async () => {
    rig = await projectRig();
    const current = await rig.projects.create({ name: "Still open" });
    const sub = path.join(rig.dir, "from-the-future");
    await fsp.mkdir(sub);
    // A complete-looking file from a future format (fields this build doesn't know), plain and gzipped.
    const future = {
      ...(await read(current.filePath as string)),
      formatVersion: 2,
      name: "Future map",
      "x-new": { stamps: [1, 2, 3] },
    };
    const plain = path.join(sub, "future.slabyrinth");
    const zipped = path.join(sub, "future-gz.slabyrinth");
    await fsp.writeFile(plain, JSON.stringify(future));
    await fsp.writeFile(zipped, gzipSync(Buffer.from(JSON.stringify(future))));
    const before = new Map<string, Buffer>();
    for (const f of [plain, zipped]) before.set(f, await fsp.readFile(f));
    const stats = new Map<string, number>();
    for (const f of [plain, zipped]) stats.set(f, (await fsp.stat(f)).mtimeMs);

    for (const f of [plain, zipped]) {
      rig.dialogs.next.openFile = f; // picked in the native open dialog
      await expect(rig.projects.open({})).rejects.toMatchObject({
        code: "validation",
        message: "This map was made with a newer version of Slabyrinth. Update to open it.",
      });
    }
    await rig.projects.flush();
    // Byte-for-byte unchanged, never rewritten, and no lock, backup or migration copy next to it.
    for (const f of [plain, zipped]) {
      expect((await fsp.readFile(f)).equals(before.get(f) as Buffer)).toBe(true);
      expect((await fsp.stat(f)).mtimeMs).toBe(stats.get(f));
    }
    expect((await fsp.readdir(sub)).sort()).toEqual(["future-gz.slabyrinth", "future.slabyrinth"]);
    // The map that was open stays open.
    expect(rig.projects.snapshot().name).toBe("Still open");
  });

  it("reads gzip project files and preserves unknown x-* keys", async () => {
    rig = await projectRig();
    const snap = await rig.projects.create({ name: "Zipped" });
    const file = snap.filePath as string;
    await rig.projects.close({});
    const json = await read(file);
    json["x-future"] = { keep: true };
    await fsp.writeFile(file, gzipSync(Buffer.from(JSON.stringify(json))));
    await rig.projects.open({ path: file });
    rig.projects.updateBrief({ tone: "x" });
    await rig.projects.flush();
    expect((await read(file))["x-future"]).toEqual({ keep: true });
  });

  it("runs core's migration hook for older formats and keeps a pre-migration copy", async () => {
    const migrated: unknown[] = [];
    rig = await projectRig({
      core: corePort({
        migrate: (j) => {
          migrated.push(j);
          return { ...(j as object), formatVersion: 1 };
        },
      }),
    });
    const snap = await rig.projects.create({ name: "Old" });
    const file = snap.filePath as string;
    await rig.projects.close({});
    const json = await read(file);
    json["formatVersion"] = 0;
    await fsp.writeFile(file, JSON.stringify(json));
    await rig.projects.open({ path: file });
    expect(migrated).toHaveLength(1);
    expect(fs.existsSync(`${file}.v0.bak`)).toBe(true);
    await rig.projects.flush();
    expect((await read(file))["formatVersion"]).toBe(1);
  });

  it("offers the .bak when the file is damaged", async () => {
    rig = await projectRig();
    const snap = await rig.projects.create({ name: "Damaged" });
    const file = snap.filePath as string;
    rig.projects.updateBrief({ tone: "first" });
    await rig.projects.flush();
    rig.projects.updateBrief({ tone: "second" });
    await rig.projects.flush(); // .bak now holds "first"
    await rig.projects.close({});
    await fsp.writeFile(file, '{"format":"slabyrinth/project@1","formatVers'); // torn by an outside tool
    rig.dialogs.next.confirm = true;
    const opened = await rig.projects.open({ path: file });
    expect(rig.dialogs.asked).toContain("confirm:Damaged map file");
    expect(opened?.brief.tone).toEqual({ value: "first", source: "user" });
    expect(fs.existsSync(`${file}.damaged`)).toBe(true);
  });

  it("single-writer lock: a live lock from another process asks; a stale one is taken over", async () => {
    rig = await projectRig({ lockEnv: { pid: 100, host: "pc", isPidAlive: (pid) => pid === 200 } });
    const snap = await rig.projects.create({ name: "Locked" });
    const file = snap.filePath as string;
    await rig.projects.close({});
    await fsp.writeFile(`${file}.lock`, JSON.stringify({ app: "slabyrinth", pid: 200, host: "pc", at: "" }));
    rig.dialogs.next.confirm = false;
    await expect(rig.projects.open({ path: file })).rejects.toMatchObject({ code: "busy" });
    await fsp.writeFile(`${file}.lock`, JSON.stringify({ app: "slabyrinth", pid: 300, host: "pc", at: "" }));
    await expect(rig.projects.open({ path: file })).resolves.toMatchObject({ name: "Locked" });
    expect(JSON.parse(await fsp.readFile(`${file}.lock`, "utf8"))).toMatchObject({ pid: 100 });
  });

  it("renames the project and its file, duplicates, trashes and lists", async () => {
    rig = await projectRig();
    const snap = await rig.projects.create({ name: "Alpha" });
    rig.projects.commitVersion({
      plan: FIXTURE_PLAN,
      author: "ai",
      summary: "v1",
      cause: { type: "create" },
    });
    await rig.projects.rename("Beta: the sequel?");
    const renamed = rig.projects.filePath as string;
    expect(path.basename(renamed)).toBe("Beta- the sequel-.slabyrinth");
    expect(fs.existsSync(snap.filePath as string)).toBe(false);
    expect(fs.existsSync(`${renamed}.lock`)).toBe(true);
    const dup = await rig.projects.duplicate(renamed);
    const dupJson = await read(dup.path);
    expect(dupJson["name"]).toBe("Beta: the sequel? (copy)");
    expect(dupJson["id"]).not.toBe(rig.projects.getProject()?.id);
    const list = await rig.projects.list();
    expect(list.map((e) => e.name).sort()).toEqual(["Beta: the sequel?", "Beta: the sequel? (copy)"]);
    expect(list.find((e) => e.name === "Beta: the sequel?")).toMatchObject({
      levels: 1,
      rooms: 2,
      phase: "plan",
      exists: true,
    });
    await rig.projects.trash(dup.path);
    expect(rig.trashed).toEqual([dup.path]);
    expect((await rig.projects.list()).map((e) => e.name)).toEqual(["Beta: the sequel?"]);
  });

  it("saveCopyAs / exportPlan / importPlan go through the dialogs", async () => {
    rig = await projectRig();
    await rig.projects.create({ name: "Copy source" });
    expect(await rig.projects.saveCopyAs()).toBeNull(); // cancelled
    rig.dialogs.next.saveFile = path.join(rig.dir, "copy.slabyrinth");
    expect(await rig.projects.saveCopyAs()).toEqual({ path: path.join(rig.dir, "copy.slabyrinth") });
    rig.projects.commitVersion({
      plan: FIXTURE_PLAN,
      author: "ai",
      summary: "v1",
      cause: { type: "create" },
    });
    const out = path.join(rig.dir, "plan.json");
    rig.dialogs.next.saveFile = null;
    expect(await rig.projects.exportPlan()).toBeNull(); // cancelled → nothing written
    rig.dialogs.next.saveFile = out;
    expect(await rig.projects.exportPlan()).toEqual({ path: out });
    expect(rig.dialogs.asked).toContain("save:Export map plan");
    rig.dialogs.next.openFile = out;
    const imported = await rig.projects.importPlan();
    expect(rig.dialogs.asked).toContain("open:Import map plan");
    expect(imported?.head).toBe(1);
    expect(imported?.plan?.title).toBe("The Fake Crypt");
    expect(imported?.name).toBe("The Fake Crypt");
  });

  it("sanitizes file names", () => {
    expect(sanitizeFileName('a<b>c:"d/e\\f|g?h*')).toBe("a-b-c--d-e-f-g-h-");
    expect(sanitizeFileName("CON")).toBe("_CON");
    expect(sanitizeFileName("  ..  ")).toBe("Untitled map");
  });
});

describe("ProjectService: plan history", () => {
  const setup = async (applyOps = true): Promise<ProjectRig> => {
    rig = await projectRig({ core: corePort({ applyOps }) });
    await rig.projects.create({ name: "History" });
    rig.projects.commitVersion({
      plan: FIXTURE_PLAN,
      author: "ai",
      summary: "v1",
      cause: { type: "create" },
    });
    return rig;
  };

  it("applyOps → undo → redo → restore follow the contract pointer semantics", async () => {
    const r = await setup();
    const res = r.projects.applyOps({
      baseVersion: 1,
      label: "Add brazier",
      ops: [{ op: "add_features", level: "l1", features: [{ id: "b1", type: "brazier", at: [3, 5] }] }],
    });
    expect(res.ok && res.version).toBe(2);
    expect(r.projects.undo()).toEqual({ head: 1 });
    expect(r.projects.snapshot().undone).toEqual([2]);
    expect(r.projects.snapshot().plan?.levels[0]?.features.map((f) => f.id)).toEqual(["coffin"]);
    expect(r.projects.redo()).toEqual({ head: 2 });
    expect(r.projects.snapshot().plan?.levels[0]?.features.map((f) => f.id)).toEqual(["coffin", "b1"]);
    expect(r.projects.restore(1)).toEqual({ head: 3 });
    const v3 = r.projects.snapshot().versions.find((v) => v.number === 3);
    expect(v3).toMatchObject({
      author: "restore",
      parentNumber: 2,
      causeType: "restore",
      summary: "Restored v1",
    });
    // v2 is rebuilt by replaying its ops from the v1 keyframe.
    expect(r.projects.getVersion(2).levels[0]?.features).toHaveLength(2);
    expect(r.projects.diff(1, 2).added).toEqual([{ id: "b1", kind: "feature", levelId: "l1" }]);
    const planEvents = r.emit.events.filter((e) => e.channel === "plan:changed");
    expect(planEvents.length).toBeGreaterThanOrEqual(5);
  });

  it("moveHead back to 0 (Retry of the first draft) tells the renderer: plan:changed with plan null", async () => {
    const r = await setup();
    r.emit.events.length = 0;
    expect(r.projects.moveHead(0)).toEqual({ head: 0 });
    const ev = r.emit.events.filter((e) => e.channel === "plan:changed");
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ head: 0, plan: null, version: { number: 1 } });
    expect(r.projects.snapshot().plan).toBeNull();
  });

  it("refuses stale base versions, UI edits while a turn runs, and undo past v1", async () => {
    const r = await setup();
    expect(() => r.projects.applyOps({ baseVersion: 7, label: "x", ops: [{ op: "renumber" }] })).toThrow(
      /changed/,
    );
    r.projects.setBusy({ turnId: "t1" });
    expect(() => r.projects.undo()).toThrow(expect.objectContaining({ code: "busy" }) as Error);
    r.projects.setBusy(null);
    expect(() => r.projects.undo()).toThrow(/first version/);
  });

  it("merges text edits of the same element within 2 minutes into one version", async () => {
    const r = await setup();
    expect(r.projects.editText({ id: "entry", set: { notes: "A" } })).toEqual({ head: 2 });
    expect(r.projects.editText({ id: "entry", set: { name: "Hall" } })).toEqual({ head: 2 });
    expect(r.projects.editText({ id: "tomb", set: { notes: "B" } })).toEqual({ head: 3 });
    const entry = r.projects.getVersion(2).levels[0]?.areas.find((a) => a.id === "entry");
    expect(entry).toMatchObject({ notes: "A", name: "Hall" });
    expect(() => r.projects.editText({ id: "entry", set: { shape: "x" } })).toThrow(/text field/);
  });

  // History storage (keyframes, replay) is core's (services/history.ts delegates to @slabyrinth/core/history),
  // so it no longer depends on the injected applyOps port; only UI op edits are refused without it.
  it("works without the core applyOps port: UI ops refused, text edits still apply and undo", async () => {
    const r = await setup(false);
    expect(() => r.projects.applyOps({ baseVersion: 1, label: "x", ops: [{ op: "renumber" }] })).toThrow(
      expect.objectContaining({ code: "unsupported" }) as Error,
    );
    expect(r.projects.editText({ id: "tomb", set: { notes: "fallback" } })).toEqual({ head: 2 });
    r.projects.undo();
    expect(r.projects.snapshot().plan?.levels[0]?.areas.find((a) => a.id === "tomb")?.notes).toBeUndefined();
  });

  it("approval blocks on errors and unreachable areas, and passes otherwise", async () => {
    rig = await projectRig({
      core: corePort({
        validate: (p) =>
          p.levels[0]?.areas.some((a) => a.notes === "bad")
            ? [{ severity: "warning", code: "unreachable", message: "Room 2 can't be reached" }]
            : [],
      }),
    });
    await rig.projects.create({ name: "Approve" });
    rig.projects.commitVersion({
      plan: FIXTURE_PLAN,
      author: "ai",
      summary: "v1",
      cause: { type: "create" },
    });
    expect(rig.projects.approve(1)).toEqual({ approved: true, blocking: [], warnings: [] });
    expect(rig.projects.snapshot().conversation.phase).toBe("build");
    rig.projects.editText({ id: "tomb", set: { notes: "bad" } });
    expect(rig.projects.approve(2)).toMatchObject({ approved: false, blocking: ["Room 2 can't be reached"] });
  });
});
