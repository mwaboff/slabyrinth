import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "./externalUrls";
import { createFileLogger, redact } from "./logger";
import { makeAppPaths } from "./paths";
import { recordingEmitter } from "./services/events";
import { ImageBridge } from "./services/imageBridge";
import { clampToDisplays, loadWindowState, saveWindowState } from "./windowState";

describe("shell:openExternal allowlist", () => {
  it("allows https to the listed hosts only", () => {
    for (const ok of [
      "https://console.anthropic.com/settings/keys",
      "https://docs.claude.com/x",
      "https://talespire.com/",
      "https://github.com/mwaboff/slabyrinth/releases",
    ]) {
      expect(isAllowedExternalUrl(ok), ok).toBe(true);
    }
    for (const bad of [
      "http://console.anthropic.com",
      "https://console.anthropic.com.evil.com",
      "https://user:pw@console.anthropic.com",
      "https://console.anthropic.com:8443/",
      "https://github.com/someone/else",
      "file:///C:/Windows/notepad.exe",
      "javascript:alert(1)",
      "steam://rungameid/720620",
      "not a url",
    ]) {
      expect(isAllowedExternalUrl(bad), bad).toBe(false);
    }
  });
});

describe("logger", () => {
  it("redacts keys and prompt text, and rotates files", async () => {
    expect(
      redact({
        apiKey: "sk-ant-api03-abcdefghijklmnop",
        text: "my secret prompt",
        note: "key sk-ant-api03-abcdefghijklmnop leaked",
      }),
    ).toEqual({
      apiKey: "[redacted]",
      text: "[redacted]",
      note: "key sk-ant-…[redacted] leaked",
    });
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "slab-log-"));
    const log = createFileLogger({ dir, maxBytes: 400, maxFiles: 3 });
    for (let i = 0; i < 30; i++) log.info(`line ${String(i)}`, { apiKey: "sk-ant-api03-zzzzzzzzzzzzzzzz" });
    const files = (await fsp.readdir(dir)).sort();
    expect(files).toEqual(["main.log", "main.log.1", "main.log.2"]);
    const all = (await Promise.all(files.map((f) => fsp.readFile(path.join(dir, f), "utf8")))).join("");
    expect(all).not.toContain("zzzzzzzz");
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe("image bridge", () => {
  it("round-trips a request, rejects non-PNG data and times out", async () => {
    const emit = recordingEmitter();
    const bridge = new ImageBridge(emit, 50);
    const p = bridge.request({ level: "l1", showIds: false, planVersion: 1, maxPx: 256 });
    const req = emit.events[0]?.payload as { requestId: string };
    bridge.handleResult({ requestId: req.requestId, ok: true, pngBase64: "iVBORw0KGgoAAAA" });
    await expect(p).resolves.toBe("iVBORw0KGgoAAAA");

    const q = bridge.request({ level: "l1", showIds: false, planVersion: 1, maxPx: 256 });
    const req2 = emit.events[1]?.payload as { requestId: string };
    bridge.handleResult({ requestId: req2.requestId, ok: true, pngBase64: "PHN2Zz4=" });
    await expect(q).rejects.toMatchObject({ code: "validation" });

    await expect(
      bridge.request({ level: "l1", showIds: false, planVersion: 1, maxPx: 256 }),
    ).rejects.toMatchObject({ code: "internal" });
    expect(bridge.pendingCount).toBe(0);
  });
});

describe("paths and window state", () => {
  it("keeps user palettes and the orientation override under userData", () => {
    const p = makeAppPaths({ userData: "/u", documents: "/d" });
    expect(p.userPalettes).toBe(path.join("/u", "palettes"));
    expect(p.orientationOverride).toBe(path.join("/u", "orientation.json"));
    expect(p.defaultProjectsFolder).toBe(path.join("/d", "Slabyrinth"));
    expect(
      makeAppPaths({ userData: "/u", documents: "/d", projectsFolderOverride: "/p" }).defaultProjectsFolder,
    ).toBe("/p");
  });

  it("restores bounds only when visible on a display", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "slab-win-"));
    const f = path.join(dir, "w.json");
    saveWindowState(f, { x: 3000, y: 100, width: 1400, height: 900, maximized: true });
    const s = loadWindowState(f);
    expect(s).toEqual({ x: 3000, y: 100, width: 1400, height: 900, maximized: true });
    expect(clampToDisplays(s, [{ x: 0, y: 0, width: 1920, height: 1080 }])).toEqual({
      width: 1400,
      height: 900,
      maximized: true,
    });
    expect(clampToDisplays(s, [{ x: 1920, y: 0, width: 2560, height: 1440 }])).toEqual(s);
    await fsp.writeFile(f, "nonsense");
    expect(loadWindowState(f)).toEqual({ width: 1280, height: 800, maximized: false });
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
