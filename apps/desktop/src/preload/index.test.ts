import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlabyrinthApi } from "../shared/ipc";

const exposed: Record<string, unknown> = {};
const invoke = vi.fn<(channel: string, req: unknown) => Promise<unknown>>(() =>
  Promise.resolve({ ok: true, value: "pong" }),
);
const on = vi.fn();
const removeListener = vi.fn();
const send = vi.fn();

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposed[key] = api;
    },
  },
  ipcRenderer: { invoke, on, removeListener, send },
}));

describe("preload bridge", () => {
  beforeEach(async () => {
    vi.resetModules();
    await import("./index");
  });

  it("exposes only window.slabyrinth with invoke/on/send", () => {
    expect(Object.keys(exposed)).toEqual(["slabyrinth"]);
    const api = exposed["slabyrinth"] as SlabyrinthApi;
    expect(Object.keys(api).sort()).toEqual(["invoke", "on", "send"]);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it("forwards contract channels and refuses everything else without touching ipcRenderer", async () => {
    const api = exposed["slabyrinth"] as SlabyrinthApi;
    invoke.mockClear();
    await expect(api.invoke("settings:get", undefined)).resolves.toEqual({ ok: true, value: "pong" });
    expect(invoke).toHaveBeenCalledWith("settings:get", undefined);
    invoke.mockClear();
    const res = await (api.invoke as (c: string, r: unknown) => Promise<unknown>)("shell:exec", {
      cmd: "calc",
    });
    expect(res).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("subscriptions pass only the payload and can be removed; unknown events are ignored", () => {
    const api = exposed["slabyrinth"] as SlabyrinthApi;
    const seen: unknown[] = [];
    const off = api.on("plan:changed", (p) => seen.push(p));
    const registered = on.mock.calls.at(-1) as [string, (e: unknown, p: unknown) => void];
    expect(registered[0]).toBe("plan:changed");
    registered[1]({ sender: "IPC EVENT OBJECT" }, { head: 3 });
    // chat:event payloads (e.g. turn_finished.outstandingIssues) pass through untouched.
    const chat: unknown[] = [];
    api.on("chat:event", (e) => chat.push(e));
    const turnFinished = {
      type: "turn_finished",
      turnId: "t",
      stopReason: "end_turn",
      canContinue: false,
      canRetry: true,
      outstandingIssues: { errors: [{ code: "opening_blocked" }] },
    };
    (on.mock.calls.at(-1) as [string, (e: unknown, p: unknown) => void])[1]({}, turnFinished);
    expect(chat).toEqual([turnFinished]);
    expect(seen).toEqual([{ head: 3 }]);
    off();
    expect(removeListener).toHaveBeenCalledWith("plan:changed", registered[1]);
    on.mockClear();
    (api.on as (c: string, l: () => void) => () => void)("ipc:anything", () => undefined)();
    expect(on).not.toHaveBeenCalled();
  });

  it("send is limited to render:imageResult", () => {
    const api = exposed["slabyrinth"] as SlabyrinthApi;
    api.send("render:imageResult", { requestId: "r", ok: false, error: "x" });
    (api.send as (c: string, p: unknown) => void)("chat:send", {});
    expect(send).toHaveBeenCalledTimes(1);
  });
});
