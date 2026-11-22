/**
 * The add-on service as the IPC handlers use it: the pairing token, the test-only Symbiotes folder, "send this build"
 * with its guards, "don't ask again", and the events. A real link server on an ephemeral port; temp folders only.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildRecord } from "../../../../shared/project";
import { memoryLogger } from "../../../logger";
import { cancelAllDialogs } from "../../dialogs";
import { recordingEmitter } from "../../events";
import { SettingsStore } from "../../settingsStore";
import { tempDir } from "../../testing/helpers";
import { TaleSpireLinkService } from "./linkService";
import { LINK_CONFIG_FILE } from "./protocol";
import { HELPER_DIR, connectAddon } from "./testing/fakeAddon";

const SLAB = "H4sIAAAAAAAEADv369xFJgZGBgYGt3SdZ+fP7XfrVvghbvHxkgJITIfxBEMDTwOQCQAbEZZYKAAAAA==";
const services: TaleSpireLinkService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown();
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

function record(chunks: Array<{ id: string; x1: number; y1: number }>): BuildRecord {
  return {
    levels: [
      {
        levelId: "l1",
        pasteOrder: 1,
        placement: { kind: "ground" },
        chunks: chunks.map((c, i) => ({
          id: c.id,
          index: i + 1,
          globalStep: i + 1,
          label: "West",
          region: { x0: 0, y0: 0, x1: c.x1, y1: c.y1 },
          sizeBytes: 50,
          limitBytes: 30720,
          contentHash: "h",
          offset: { x: 0, y: 0, z: 0 },
          pasted: false,
        })),
      },
    ],
  } as unknown as BuildRecord;
}

type Anchor = { side: "north" | "east" | "south" | "west"; clearanceCells: number; farMarkerCells: number };

async function rig(opts: { assets?: number[]; testDir?: boolean; anchor?: Anchor } = {}) {
  const root = await tempDir("link-svc-");
  dirs.push(root);
  const settings = new SettingsStore({
    file: path.join(root, "settings.json"),
    defaultProjectsFolder: path.join(root, "Projects"),
    logger: memoryLogger(),
  });
  await settings.load();
  const symbiotes = path.join(root, "Symbiotes");
  await fsp.mkdir(symbiotes);
  const emit = recordingEmitter();
  const assets = opts.assets ?? [3, 5];
  const service = new TaleSpireLinkService({
    port: 0,
    tokenFile: path.join(root, "talespire-link.json"),
    bundledDir: fileURLToPath(HELPER_DIR),
    packageDir: path.join(root, "package"),
    folderEnv: {
      platform: "win32",
      homedir: path.join(root, "home"),
      fs: {
        stat: async (p) => {
          const st = await fsp.stat(p).catch(() => null);
          return st ? { size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() } : null;
        },
        readFile: () => Promise.reject(new Error("unused")),
        readText: () => Promise.reject(new Error("unused")),
        listDir: () => Promise.resolve([]),
      },
    },
    testSymbiotesDir: opts.testDir === false ? null : symbiotes,
    settings,
    registrar: { register: () => true, unregister: () => undefined },
    wayland: false,
    build: {
      chunksForSend: () =>
        Promise.resolve({
          record: record(assets.map((_, i) => ({ id: `l1-0${String(i + 1)}`, x1: 30, y1: 20 }))),
          ...(opts.anchor ? { pasteAnchor: opts.anchor } : {}),
          chunks: assets.map((n, i) => ({
            id: `l1-0${String(i + 1)}`,
            label: i ? "East" : "West",
            slab: SLAB,
            assetCount: n,
          })),
        }),
    },
    projects: { getProject: () => ({ name: "The Keep" }) as never },
    dialogs: cancelAllDialogs,
    openPath: () => Promise.resolve(""),
    emit,
    logger: memoryLogger(),
  });
  services.push(service);
  await service.start();
  return { root, symbiotes, service, settings, emit };
}

async function waitFor(test: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("pairing", () => {
  it("makes one token per install, keeps it across starts, and writes it into the installed add-on", async () => {
    const r = await rig();
    const token = (
      JSON.parse(await fsp.readFile(path.join(r.root, "talespire-link.json"), "utf8")) as { token: string }
    ).token;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    const s = await r.service.install();
    expect(s.state).toBe("installed");
    const cfg = JSON.parse(
      await fsp.readFile(path.join(r.symbiotes, "slabyrinth-helper", LINK_CONFIG_FILE), "utf8"),
    ) as {
      token: string;
      port: number;
    };
    expect(cfg).toEqual({ token, port: r.service.linkStatus().server.port });
    expect(r.emit.events.some((e) => e.channel === "addon:changed")).toBe(true);
  });

  it("outside test mode never looks at the test folder", async () => {
    const r = await rig({ testDir: false });
    expect((await r.service.addonStatus()).tried).not.toContain(r.symbiotes);
  });
});

describe("send this build to the add-on", () => {
  it("refuses with no add-on connected", async () => {
    const r = await rig();
    await expect(r.service.send("b1")).rejects.toMatchObject({
      code: "validation",
      message: /isn't connected/,
    });
  });

  it("sends the chunk set (name, labels, size, levels) and follows the add-on's answer", async () => {
    const r = await rig();
    await r.service.install();
    const token = (
      JSON.parse(await fsp.readFile(path.join(r.root, "talespire-link.json"), "utf8")) as { token: string }
    ).token;
    const addon = await connectAddon(r.service.linkStatus().server.port, token);
    await waitFor(() => r.service.linkStatus().helper.state === "connected");
    expect(await r.service.send("b1")).toEqual({ chunks: 2 });
    await addon.until((s) => s.set !== null);
    expect(addon.state().set).toMatchObject({
      name: "The Keep",
      size: { w: 30, h: 20 },
      levels: 1,
      chunks: [{ label: "West (l1-01)" }, { label: "East (l1-02)" }],
    });
    await waitFor(() => r.service.linkStatus().send.state === "loaded");
    expect(r.service.linkStatus().send).toEqual({ state: "loaded", buildId: "b1", chunks: 2, error: null });
    expect(r.emit.events.filter((e) => e.channel === "link:changed").length).toBeGreaterThan(2);
    r.service.stop();
    await addon.until((s) => s.set === null);
  });

  it("carries the paste anchor of a map pasted from beside it, and none for one that is not", async () => {
    const anchor: Anchor = { side: "south", clearanceCells: 4, farMarkerCells: 31 };
    for (const [opts, want] of [
      [{ anchor }, anchor],
      [{}, undefined],
    ] as const) {
      const r = await rig(opts);
      await r.service.install();
      const token = (
        JSON.parse(await fsp.readFile(path.join(r.root, "talespire-link.json"), "utf8")) as { token: string }
      ).token;
      const addon = await connectAddon(r.service.linkStatus().server.port, token);
      await waitFor(() => r.service.linkStatus().helper.state === "connected");
      await r.service.send("b1");
      await addon.until((s) => s.set !== null);
      expect(addon.state().set?.anchor ?? undefined).toEqual(want);
      r.service.stop();
      await addon.until((s) => s.set === null);
    }
  });

  it("never sends a chunk with no assets (an empty slab crashes TaleSpire)", async () => {
    const r = await rig({ assets: [4, 0] });
    const token = (
      JSON.parse(await fsp.readFile(path.join(r.root, "talespire-link.json"), "utf8")) as { token: string }
    ).token;
    const addon = await connectAddon(r.service.linkStatus().server.port, token);
    await waitFor(() => r.service.linkStatus().helper.state === "connected");
    await expect(r.service.send("b1")).rejects.toMatchObject({ code: "validation", message: /no assets/ });
    expect(addon.state().set).toBeNull();
  });
});

describe("the update dialog", () => {
  it('"don\'t ask again" is saved for this bundled version', async () => {
    const r = await rig();
    const s = await r.service.dismissPrompt("0.2.0");
    expect(s.prompt.show).toBe(false);
    expect(r.settings.get().talespire.addonPromptDismissed).toBe("0.2.0");
  });

  it("a folder chosen by hand is saved, and reset goes back to finding it", async () => {
    const r = await rig();
    await r.settings.updateInternal((s) => {
      s.talespire.symbiotesFolder = path.join(r.root, "Elsewhere");
      return s;
    });
    expect((await r.service.addonStatus()).state).toBe("not_found");
    await r.service.chooseFolder(true);
    expect(r.settings.get().talespire.symbiotesFolder).toBeNull();
    expect((await r.service.addonStatus()).state).toBe("missing");
  });
});
