/**
 * The add-on in a Symbiotes folder (temp folders only): status, install, the automatic update at start, and the
 * "update it for you?" prompt.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryLogger } from "../../../logger";
import { tempDir } from "../../testing/helpers";
import {
  ADDON_FOLDER_NAME,
  AddonService,
  folderWarning,
  plainReason,
  type FileOps,
  type LinkConfig,
} from "./addon";
import { LINK_CONFIG_FILE } from "./protocol";
import { HELPER_DIR } from "./testing/fakeAddon";

const PAIRING = { port: 48731, token: "c".repeat(48) };
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

interface Rig {
  root: string;
  symbiotes: string;
  addonDir: string;
  bundled: string;
  service: AddonService;
  dismissed: { version: string | undefined };
  bundledVersion: string;
}

/** A bundled add-on (a copy of the real one) and an empty Symbiotes folder. */
async function rig(opts: { symbiotes?: boolean } = {}): Promise<Rig> {
  const root = await tempDir("addon-");
  dirs.push(root);
  const bundled = path.join(root, "bundled");
  await fsp.cp(new URL(".", HELPER_DIR), bundled, { recursive: true });
  const symbiotes = path.join(root, "Symbiotes");
  if (opts.symbiotes !== false) await fsp.mkdir(symbiotes);
  const dismissed: { version: string | undefined } = { version: undefined };
  const service = new AddonService({
    bundledDir: bundled,
    packageDir: path.join(root, "package"),
    pairing: () => PAIRING,
    locate: async () => {
      const st = await fsp.stat(symbiotes).catch(() => null);
      return { found: st ? { path: symbiotes, source: "default" } : null, tried: [symbiotes] };
    },
    dismissed: () => dismissed.version,
    logger: memoryLogger(),
  });
  const bundledVersion = (
    JSON.parse(await fsp.readFile(path.join(bundled, "manifest.json"), "utf8")) as { version: string }
  ).version;
  return {
    root,
    symbiotes,
    addonDir: path.join(symbiotes, ADDON_FOLDER_NAME),
    bundled,
    service,
    dismissed,
    bundledVersion,
  };
}

/** An installed copy of ours at `version`, with its own pairing file. */
async function installOld(r: Rig, version: string, extra: Record<string, unknown> = {}): Promise<void> {
  await fsp.mkdir(r.addonDir, { recursive: true });
  const manifest = JSON.parse(await fsp.readFile(path.join(r.bundled, "manifest.json"), "utf8")) as object;
  await fsp.writeFile(
    path.join(r.addonDir, "manifest.json"),
    JSON.stringify({ ...manifest, version, ...extra }),
  );
  await fsp.writeFile(path.join(r.addonDir, "app.js"), "// old\n");
  await fsp.writeFile(path.join(r.addonDir, LINK_CONFIG_FILE), JSON.stringify(PAIRING));
}

/** The same rig's folders, with some file operations replaced (to make them fail). */
function withOps(r: Rig, fileOps: Partial<FileOps>, pairing: () => LinkConfig | null = () => PAIRING) {
  return new AddonService({
    bundledDir: r.bundled,
    packageDir: path.join(r.root, "package"),
    pairing,
    locate: () => Promise.resolve({ found: { path: r.symbiotes, source: "default" }, tried: [r.symbiotes] }),
    dismissed: () => undefined,
    logger: memoryLogger(),
    fileOps,
  });
}
const busy = (): Promise<never> => Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" }));
const full = (): Promise<never> => Promise.reject(Object.assign(new Error("full"), { code: "ENOSPC" }));

/** Fails the `n`th file written (1-based) with ENOSPC, as a disk filling up part way would. */
function failingWrite(n: number): FileOps["writeFile"] {
  let count = 0;
  return (file, data) => (++count === n ? full() : fsp.writeFile(file, data));
}

/** Our hidden working folders left in the Symbiotes folder. */
async function leftovers(r: Rig): Promise<string[]> {
  return (await fsp.readdir(r.symbiotes)).filter((n) => n.startsWith(`.${ADDON_FOLDER_NAME}.`));
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) await walk(r);
      else out[r] = await fsp.readFile(path.join(dir, r), "utf8");
    }
  };
  await walk("");
  return out;
}

describe("status", () => {
  it("not_found without a folder, missing in an empty one", async () => {
    const none = await rig({ symbiotes: false });
    expect(await none.service.status()).toMatchObject({
      state: "not_found",
      folder: null,
      tried: [none.symbiotes],
    });
    const empty = await rig();
    expect(await empty.service.status()).toMatchObject({
      state: "missing",
      folder: empty.symbiotes,
      folderSource: "default",
      installedVersion: null,
      prompt: { show: false },
    });
  });

  it("installed when current and paired; mismatch with another token or port; foreign for someone else's folder", async () => {
    const r = await rig();
    await r.service.install();
    expect(await r.service.status()).toMatchObject({
      state: "installed",
      installedVersion: r.bundledVersion,
      mismatch: [],
    });
    await fsp.writeFile(
      path.join(r.addonDir, LINK_CONFIG_FILE),
      JSON.stringify({ port: 1234, token: "d".repeat(48) }),
    );
    expect(await r.service.status()).toMatchObject({ state: "mismatch", mismatch: ["token", "port"] });
    await installOld(r, r.bundledVersion, { name: "Someone else's helper" });
    expect((await r.service.status()).state).toBe("foreign");
  });
});

describe("install (the user's action)", () => {
  it("copies every bundled file and the pairing file, creating the Symbiotes folder's add-on folder", async () => {
    const r = await rig();
    const s = await r.service.install();
    expect(s).toMatchObject({
      state: "installed",
      update: { state: "updated", automatic: false, to: r.bundledVersion },
    });
    const files = await snapshot(r.addonDir);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["manifest.json", "index.html", "app.js", "sequencer.js", LINK_CONFIG_FILE]),
    );
    expect(JSON.parse(files[LINK_CONFIG_FILE] ?? "")).toEqual(PAIRING);
    expect(Object.keys(files).some((f) => f.includes("slabyrinth-tmp"))).toBe(false);
  });

  it("refuses with no folder, and over a foreign folder, writing nothing", async () => {
    const none = await rig({ symbiotes: false });
    await expect(none.service.install()).rejects.toMatchObject({ code: "not_found" });
    const r = await rig();
    await fsp.mkdir(r.addonDir);
    await fsp.writeFile(path.join(r.addonDir, "readme.txt"), "mine");
    await expect(r.service.install()).rejects.toMatchObject({ code: "validation" });
    expect(await snapshot(r.addonDir)).toEqual({ "readme.txt": "mine" });
  });

  it("a failed copy reports a plain reason and leaves the old version as it was", async () => {
    const r = await rig();
    await installOld(r, "0.0.1");
    const before = await snapshot(r.addonDir);
    const service = withOps(r, { writeFile: failingWrite(3) });
    await expect(service.install()).rejects.toMatchObject({ code: "io", message: "The disk is full." });
    expect(await snapshot(r.addonDir)).toEqual(before);
    expect(await leftovers(r)).toEqual([]);
    const s = await service.status();
    expect(s).toMatchObject({
      state: "outdated",
      installedVersion: "0.0.1",
      update: { state: "failed", automatic: false },
    });
    expect(s.update.error).toMatch(/\.$/);
    expect(s.prompt).toEqual({
      show: true,
      reason: expect.stringMatching(/^The last update failed: /) as unknown,
    });
  });
});

describe("automatic update at start", () => {
  it("not installed: writes nothing", async () => {
    const r = await rig();
    const s = await r.service.autoUpdate();
    expect(s.state).toBe("missing");
    expect(await fsp.readdir(r.symbiotes)).toEqual([]);
  });

  it("installed and older: updated, pairing file kept, stale files gone, other add-ons untouched", async () => {
    const r = await rig();
    await installOld(r, "0.0.1");
    await fsp.writeFile(
      path.join(r.addonDir, LINK_CONFIG_FILE),
      JSON.stringify({ port: 5555, token: "e".repeat(48) }),
    );
    await fsp.mkdir(path.join(r.symbiotes, "other-addon"));
    await fsp.writeFile(path.join(r.symbiotes, "other-addon", "manifest.json"), "{}");
    await fsp.writeFile(path.join(r.addonDir, "removed-in-this-version.js"), "// old\n");
    const s = await r.service.autoUpdate();
    expect(s.installedVersion).toBe(r.bundledVersion);
    expect(s.update).toMatchObject({
      state: "updated",
      automatic: true,
      from: "0.0.1",
      to: r.bundledVersion,
    });
    expect(s.prompt.show).toBe(false);
    const files = await snapshot(r.addonDir);
    expect(JSON.parse(files[LINK_CONFIG_FILE] ?? "")).toEqual({ port: 5555, token: "e".repeat(48) });
    expect(files["removed-in-this-version.js"]).toBeUndefined();
    expect(files["app.js"]).toBe(await fsp.readFile(path.join(r.bundled, "app.js"), "utf8"));
    expect(await snapshot(path.join(r.symbiotes, "other-addon"))).toEqual({ "manifest.json": "{}" });
    expect(await leftovers(r)).toEqual([]);
  });

  it("installed and the same or newer: writes nothing", async () => {
    for (const v of ["SAME", "99.0.0"]) {
      const r = await rig();
      await installOld(r, v === "SAME" ? r.bundledVersion : v);
      const before = await snapshot(r.addonDir);
      const s = await r.service.autoUpdate();
      expect(s.update.state).toBe("none");
      expect(await snapshot(r.addonDir)).toEqual(before);
    }
  });

  it("a foreign folder of the same name: writes nothing", async () => {
    const r = await rig();
    await installOld(r, "0.0.1", { name: "Not ours" });
    const before = await snapshot(r.addonDir);
    expect((await r.service.autoUpdate()).state).toBe("foreign");
    expect(await snapshot(r.addonDir)).toEqual(before);
  });

  it("a failed copy is reported, never thrown; the prompt offers the update with the reason, once per version", async () => {
    const r = await rig();
    await installOld(r, "0.0.1");
    // a file in use: the old folder cannot be renamed away
    let inUse = true;
    const service = new AddonService({
      bundledDir: r.bundled,
      packageDir: path.join(r.root, "package"),
      pairing: () => PAIRING,
      locate: () =>
        Promise.resolve({ found: { path: r.symbiotes, source: "default" }, tried: [r.symbiotes] }),
      dismissed: () => r.dismissed.version,
      logger: memoryLogger(),
      fileOps: { rename: (a, b) => (inUse ? busy() : fsp.rename(a, b)) },
    });
    const s = await service.autoUpdate();
    expect(s.state).toBe("outdated");
    expect(s.update).toMatchObject({ state: "failed", automatic: true, from: "0.0.1" });
    expect(s.update.error).toMatch(/in use.*Close TaleSpire/);
    expect(s.prompt.show).toBe(true);
    expect(s.prompt.reason).toMatch(/^Updating it by itself failed: /);
    expect(await leftovers(r)).toEqual([]);
    // "don't ask again" for this bundled version: the status stays outdated, the prompt closes
    r.dismissed.version = r.bundledVersion;
    expect(await service.status()).toMatchObject({ state: "outdated", prompt: { show: false } });
    // the one-click retry, once the cause is gone
    inUse = false;
    expect(await service.install()).toMatchObject({
      state: "installed",
      update: { state: "updated", automatic: false },
    });
  });

  it("an older copy put there after start is caught on the next check, with why it was not updated", async () => {
    const r = await rig();
    await r.service.autoUpdate();
    await installOld(r, "0.0.1");
    const s = await r.service.status();
    expect(s).toMatchObject({ state: "outdated", prompt: { show: true } });
    expect(s.prompt.reason).toMatch(/after Slabyrinth started/);
  });
});

describe("install and update through a staging folder", () => {
  it("a first install that stops part way leaves no half-copy: the next install works", async () => {
    const r = await rig();
    for (const n of [1, 2, 5]) {
      const broken = withOps(r, { writeFile: failingWrite(n) });
      await expect(broken.install()).rejects.toMatchObject({ code: "io", message: "The disk is full." });
      // never "foreign" (which would lock install and uninstall out): there is simply nothing there
      expect((await broken.status()).state).toBe("missing");
      expect(await fsp.readdir(r.symbiotes)).toEqual([]);
    }
    expect((await r.service.install()).state).toBe("installed");
  });

  it("the app killed part way: the next run clears its hidden leftovers and installs", async () => {
    const r = await rig();
    await fsp.mkdir(path.join(r.symbiotes, `.${ADDON_FOLDER_NAME}.installing-0badc0de`));
    await fsp.writeFile(path.join(r.symbiotes, `.${ADDON_FOLDER_NAME}.installing-0badc0de`, "app.js"), "//");
    await fsp.mkdir(path.join(r.symbiotes, `.${ADDON_FOLDER_NAME}.removing-12345678`));
    // not ours by name: kept
    await fsp.mkdir(path.join(r.symbiotes, `.${ADDON_FOLDER_NAME}.mine`));
    await fsp.mkdir(path.join(r.symbiotes, "other-addon"));
    expect((await r.service.install()).state).toBe("installed");
    expect((await fsp.readdir(r.symbiotes)).sort()).toEqual(
      [`.${ADDON_FOLDER_NAME}.mine`, ADDON_FOLDER_NAME, "other-addon"].sort(),
    );
  });

  it("a swap that stopped between its two renames: the old copy is put back, then updated", async () => {
    const r = await rig();
    await installOld(r, "0.0.1");
    const hidden = path.join(r.symbiotes, `.${ADDON_FOLDER_NAME}.old-deadbeef`);
    await fsp.rename(r.addonDir, hidden);
    await fsp.mkdir(path.join(r.symbiotes, `.${ADDON_FOLDER_NAME}.installing-deadbeef`));
    expect((await r.service.status()).state).toBe("missing");
    const s = await r.service.autoUpdate();
    expect(s).toMatchObject({ state: "installed", update: { state: "updated", from: "0.0.1" } });
    // its pairing file came back with it, and was kept by the update
    expect(JSON.parse(await fsp.readFile(path.join(r.addonDir, LINK_CONFIG_FILE), "utf8"))).toEqual(PAIRING);
    expect(await leftovers(r)).toEqual([]);
  });

  it("the new folder cannot be moved in: the old one is put back as it was", async () => {
    const r = await rig();
    await installOld(r, "0.0.1");
    const before = await snapshot(r.addonDir);
    const service = withOps(r, {
      rename: (a, b) => (path.basename(a).includes(".installing-") ? busy() : fsp.rename(a, b)),
    });
    await expect(service.install()).rejects.toMatchObject({ code: "io", message: /in use/ });
    expect(await snapshot(r.addonDir)).toEqual(before);
    expect(await leftovers(r)).toEqual([]);
  });

  it("a pairing not ready yet: install refuses in plain words, status says mismatch, nothing throws", async () => {
    const r = await rig();
    const early = withOps(r, {}, () => null);
    await expect(early.install()).rejects.toMatchObject({ code: "io", message: /still starting/ });
    expect(await fsp.readdir(r.symbiotes)).toEqual([]);
    await r.service.install();
    expect(await early.status()).toMatchObject({ state: "mismatch", mismatch: ["token", "port"] });
  });
});

describe("uninstall (the user's action)", () => {
  it("removes our folder and nothing else; afterwards the automatic update does nothing", async () => {
    const r = await rig();
    await r.service.install();
    await fsp.mkdir(path.join(r.symbiotes, "other-addon"));
    await fsp.writeFile(path.join(r.symbiotes, "other-addon", "manifest.json"), "{}");
    await fsp.writeFile(path.join(r.symbiotes, "loose.txt"), "x");
    const s = await r.service.uninstall(false);
    expect(s).toMatchObject({ state: "missing", installedVersion: null });
    expect((await fsp.readdir(r.symbiotes)).sort()).toEqual(["loose.txt", "other-addon"]);
    expect((await r.service.autoUpdate()).state).toBe("missing");
    expect((await fsp.readdir(r.symbiotes)).sort()).toEqual(["loose.txt", "other-addon"]);
  });

  it("refuses a same-named folder that is not ours, and a link that points outside", async () => {
    const r = await rig();
    await installOld(r, "1.0.0", { name: "Not ours" });
    await expect(r.service.uninstall(false)).rejects.toMatchObject({ code: "validation" });
    expect(await fsp.readdir(r.addonDir)).toContain("manifest.json");

    const l = await rig();
    const outside = path.join(l.root, "outside", ADDON_FOLDER_NAME);
    await fsp.cp(l.bundled, outside, { recursive: true });
    // a junction on Windows (no admin needed), a symlink elsewhere
    await fsp.symlink(outside, l.addonDir, process.platform === "win32" ? "junction" : "dir");
    await expect(l.service.uninstall(false)).rejects.toMatchObject({ code: "validation" });
    expect(await fsp.readdir(outside)).toContain("manifest.json");
    expect((await fsp.lstat(l.addonDir)).isSymbolicLink()).toBe(true);
  });

  it("a file in use stops it before anything is deleted, with a plain reason", async () => {
    const r = await rig();
    await r.service.install();
    const before = await snapshot(r.addonDir);
    const s = withOps(r, { rename: busy, rm: () => Promise.resolve() });
    await expect(s.uninstall(false)).rejects.toMatchObject({ code: "io", message: /in use/ });
    expect(await snapshot(r.addonDir)).toEqual(before);
    expect((await s.status()).state).toBe("installed");
  });

  it("a delete that stops half way says where the files are left, and TaleSpire no longer sees the add-on", async () => {
    const r = await rig();
    await r.service.install();
    const s = withOps(r, { rm: busy });
    await expect(s.uninstall(false)).rejects.toMatchObject({
      code: "io",
      message: /some files are left in .*\.slabyrinth-helper\.removing-/,
    });
    expect((await s.status()).state).toBe("missing");
    expect(
      (await fsp.readdir(r.symbiotes)).filter((n) => n.startsWith(".slabyrinth-helper.removing-")),
    ).toHaveLength(1);
  });

  it('removes the copy left in the folder used before ("move it")', async () => {
    const r = await rig();
    const old = path.join(r.root, "OldSymbiotes");
    await fsp.mkdir(path.join(old, ADDON_FOLDER_NAME), { recursive: true });
    await fsp.copyFile(
      path.join(r.bundled, "manifest.json"),
      path.join(old, ADDON_FOLDER_NAME, "manifest.json"),
    );
    const moved = new AddonService({
      bundledDir: r.bundled,
      packageDir: path.join(r.root, "package"),
      pairing: () => PAIRING,
      locate: () => Promise.resolve({ found: { path: r.symbiotes, source: "manual" }, tried: [r.symbiotes] }),
      dismissed: () => undefined,
      others: () => Promise.resolve([old]),
      logger: memoryLogger(),
    });
    const s = await moved.status();
    expect(s.elsewhere).toEqual({ folder: old, version: r.bundledVersion });
    // chosen by hand, and not under a TaleSpire folder: kept, with a warning
    expect(s.folderWarning).toMatch(/doesn't look like/);
    await moved.install();
    expect((await moved.uninstall(true)).elsewhere).toBeNull();
    expect(await fsp.readdir(old)).toEqual([]);
    expect((await moved.status()).state).toBe("installed");
  });
});

describe("a paired copy to install by hand", () => {
  it("is prepared under the app's data with the pairing file", async () => {
    const r = await rig();
    const dir = await r.service.preparePackage();
    expect(dir).toBe(path.join(r.root, "package", ADDON_FOLDER_NAME));
    expect(JSON.parse(await fsp.readFile(path.join(dir, LINK_CONFIG_FILE), "utf8"))).toEqual(PAIRING);
  });
});

describe("a folder chosen by hand", () => {
  it("warns when it is not TaleSpire's Symbiotes folder", () => {
    expect(
      folderWarning("C:\\Users\\gm\\AppData\\LocalLow\\BouncyRock Entertainment\\TaleSpire\\Symbiotes"),
    ).toBeNull();
    expect(folderWarning("/home/gm/pfx/TaleSpire/Symbiotes/")).toBeNull();
    expect(folderWarning("D:\\Games\\Symbiotes")).toMatch(/doesn't look like/);
  });
});

describe("plain reasons", () => {
  it("names the common file-system failures in words", () => {
    const e = (code: string): Error => Object.assign(new Error("x"), { code });
    expect(plainReason(e("EPERM"))).toMatch(/isn't allowed/);
    expect(plainReason(e("EBUSY"))).toMatch(/in use/);
    expect(plainReason(e("EWEIRD"))).toBe("The files could not be copied (EWEIRD).");
    expect(plainReason("?")).toBe("The files could not be copied.");
  });
});
