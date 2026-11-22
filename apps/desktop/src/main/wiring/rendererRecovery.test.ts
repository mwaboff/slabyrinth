import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";
import { memoryLogger } from "../logger";
import { cancelAllDialogs, type Dialogs } from "../services/dialogs";
import { crashPolicy, recoveredUrl, watchRenderer } from "./rendererRecovery";

function fakeWindow() {
  const webContents = new EventEmitter();
  const loaded: string[] = [];
  let closed = false;
  const win = {
    webContents,
    isDestroyed: () => closed,
    loadURL: (url: string) => {
      loaded.push(url);
      return Promise.resolve();
    },
    close: () => {
      closed = true;
    },
  };
  return { win: win as unknown as BrowserWindow, webContents, loaded, isClosed: () => closed };
}

const gone = (reason: string) => [{}, { reason, exitCode: 1 }] as const;

describe("a renderer that dies", () => {
  it("is reloaded with a plain reason, twice; a third time in two minutes asks instead of looping", async () => {
    let t = 0;
    const asked: string[] = [];
    const dialogs: Dialogs = {
      ...cancelAllDialogs,
      confirm: (o) => {
        asked.push(o.message);
        return Promise.resolve(false);
      },
    };
    const w = fakeWindow();
    watchRenderer(w.win, "file:///C:/app/renderer/index.html", {
      logger: memoryLogger(),
      dialogs,
      now: () => t,
    });
    w.webContents.emit("render-process-gone", ...gone("oom"));
    t += 10_000;
    w.webContents.emit("render-process-gone", ...gone("crashed"));
    expect(w.loaded).toEqual([
      "file:///C:/app/renderer/index.html?recovered=oom",
      "file:///C:/app/renderer/index.html?recovered=crash",
    ]);
    t += 10_000;
    w.webContents.emit("render-process-gone", ...gone("oom"));
    await Promise.resolve();
    await Promise.resolve();
    expect(w.loaded).toHaveLength(2);
    expect(asked).toEqual(["Slabyrinth keeps running out of memory showing this map."]);
    expect(w.isClosed()).toBe(true);
  });

  it("a clean exit is not a crash; crashes far apart each reload", () => {
    const p = crashPolicy(120_000, 2);
    expect(p.onGone("clean-exit", 0)).toBe("ignore");
    expect(p.onGone("oom", 0)).toBe("reload");
    expect(p.onGone("oom", 200_000)).toBe("reload");
    expect(p.onGone("oom", 400_000)).toBe("reload");
    expect(recoveredUrl("http://localhost:5173/", "killed")).toBe("http://localhost:5173/?recovered=crash");
  });
});
