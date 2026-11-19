import { describe, expect, it } from "vitest";
import type { IpcRequests } from "../../shared/ipc";
import { REQUEST_CHANNELS, SEND_CHANNELS } from "../../shared/channels";
import { memoryLogger } from "../logger";
import { EnginePortError } from "../ports/engine";
import { AppFailure } from "../util/errors";
import { createDispatcher, makeSenderCheck, registerIpc, type Handlers, type IpcEventLike } from "./router";
import { requestSchemas, sendSchemas } from "./schemas";

const APP_URL = "file:///C:/Program%20Files/Slabyrinth/resources/app.asar/out/renderer/index.html";
const trusted = makeSenderCheck(APP_URL);

/** Handlers that echo their (validated) payload, so the tests see exactly what reached them. */
function echoHandlers(): Handlers {
  const h: Record<string, (req: unknown) => unknown> = {};
  for (const c of REQUEST_CHANNELS) h[c] = (req) => ({ channel: c, req });
  return h as unknown as Handlers;
}

describe("IPC router", () => {
  it("has a schema for every contract channel and nothing else", () => {
    expect(Object.keys(requestSchemas).sort()).toEqual([...REQUEST_CHANNELS].sort());
    expect(Object.keys(sendSchemas).sort()).toEqual([...SEND_CHANNELS].sort());
  });

  it("rejects requests from any page other than the app's renderer", async () => {
    const d = createDispatcher(echoHandlers(), requestSchemas, trusted, memoryLogger());
    for (const url of [
      undefined,
      "https://evil.example/index.html",
      "file:///C:/Users/x/Downloads/index.html",
      "devtools://devtools/bundled/x.html",
    ]) {
      const r = await d("settings:get", url, undefined);
      expect(r).toMatchObject({ ok: false, error: { code: "validation" } });
    }
    expect(await d("settings:get", `${APP_URL}#/home`, undefined)).toMatchObject({ ok: true });
  });

  it("dev server origin check", () => {
    const dev = makeSenderCheck("http://localhost:5173/");
    expect(dev("http://localhost:5173/index.html")).toBe(true);
    expect(dev("http://localhost:5174/")).toBe(false);
    expect(dev("http://127.0.0.1:5173/")).toBe(false);
  });

  it("rejects unknown channels (no generic invoke escape hatch)", async () => {
    const d = createDispatcher(echoHandlers(), requestSchemas, trusted, memoryLogger());
    expect(await d("fs:readFile", APP_URL, { path: "C:/secret" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(await d("__proto__", APP_URL, {})).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("validates payloads strictly", async () => {
    const d = createDispatcher(echoHandlers(), requestSchemas, trusted, memoryLogger());
    const bad: Array<[keyof IpcRequests, unknown]> = [
      ["settings:get", { sneaky: true }],
      ["secrets:setApiKey", { providerId: "anthropic" }],
      ["secrets:setApiKey", { providerId: "../../etc", apiKey: "sk-ant-xxxxxxxx" }],
      ["project:rename", { name: "" }],
      ["project:open", { path: "a\0b" }],
      ["plan:applyOps", { baseVersion: 1, label: "x", ops: [{ op: "rm -rf" }] }],
      ["plan:applyOps", { baseVersion: -1, label: "x", ops: [{ op: "renumber" }] }],
      ["chat:send", { text: "hi", extra: 1 }],
      ["chat:setEffort", { effort: "ludicrous" }],
      [
        "export:savePng",
        { suggestedName: "a", files: [{ levelId: "l1", pngBase64: "not base64!" }], options: {} },
      ],
      ["talespire:copyAndOpen", { text: "" }],
      ["settings:update", { ui: { theme: "neon" } }],
      ["settings:update", { spending: { allTime: { usage: {} } } }],
      ["secrets:setApiKey", { providerId: "anthropic", apiKey: "sk-ant-xxxxxxxx", storage: "plaintext" }],
      ["project:setUiState", { ui: { tab: "settings" } }],
      ["project:setUiState", { ui: { zoom: 2, filePath: "C:/x" } }],
      ["project:setUiState", { pasteGuide: { buildId: "b", currentStep: -1 } }],
      ["clipboard:writeText", { text: "x", chunk: { buildId: "b" } }],
      ["talespire:copyAndOpen", { text: "x", chunk: { buildId: "b", chunkId: "c", extra: 1 } }],
      ["updates:status", { manual: true }],
      ["updates:check", {}],
      ["updates:check", { manual: "yes" }],
      ["updates:check", { manual: true, url: "https://evil.example" }],
      ["updates:skip", { version: "latest" }],
      ["updates:skip", { version: "v0.2.0" }],
      ["updates:skip", { version: "0.2.0", tag: "v0.2.0" }],
      ["settings:update", { updates: { skippedVersion: "0.2.0" } }],
      ["settings:update", { updates: { lastCheckedAt: "2026-01-01T00:00:00Z" } }],
    ];
    for (const [channel, payload] of bad) {
      const r = await d(channel, APP_URL, payload);
      expect(r.ok, `${channel} ${JSON.stringify(payload)}`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("validation");
    }
    const good = await d("chat:send", APP_URL, { text: "Make room 2 bigger", intent: "plan" });
    expect(good).toEqual({
      ok: true,
      value: { channel: "chat:send", req: { text: "Make room 2 bigger", intent: "plan" } },
    });
    expect(await d("plan:undo", APP_URL, undefined)).toMatchObject({ ok: true });
    for (const [channel, payload] of [
      ["secrets:setApiKey", { providerId: "anthropic", apiKey: "sk-ant-xxxxxxxx", storage: "allow_weak" }],
      [
        "project:setUiState",
        { ui: { tab: "build", levelId: "l1", zoom: 1.5, pan: [3, 4] }, pasteGuide: null },
      ],
      ["project:setUiState", { pasteGuide: { buildId: "b", currentStep: 2 } }],
      ["clipboard:writeText", { text: "x", chunk: { buildId: "b", chunkId: "c" } }],
      ["talespire:copyAndOpen", { text: "x", chunk: { buildId: "b", chunkId: "c" } }],
      ["updates:status", undefined],
      ["updates:check", { manual: false }],
      ["updates:skip", { version: "0.2.0" }],
      ["updates:skip", { version: "1.0.0-rc.1" }],
      ["settings:update", { updates: { autoCheck: false } }],
    ] as Array<[keyof IpcRequests, unknown]>) {
      expect((await d(channel, APP_URL, payload)).ok, channel).toBe(true);
    }
  });

  it("never throws across IPC: errors become Result.error", async () => {
    const h = echoHandlers() as unknown as Record<string, () => unknown>;
    h["plan:undo"] = () => {
      throw new AppFailure("busy", "Slabyrinth is revising the map.");
    };
    h["plan:redo"] = () => {
      throw new Error("kaboom with sk-ant-api03-SECRETSECRETSECRET in it");
    };
    h["chat:send"] = () => {
      throw new EnginePortError({ code: "no_api_key", message: "Add your key." });
    };
    h["providers:check"] = () => {
      throw Object.assign(new Error("x"), {
        info: { kind: "rate_limit", retryable: true, message: "Slow down" },
      });
    };
    const logger = memoryLogger();
    const d = createDispatcher(h as unknown as Handlers, requestSchemas, trusted, logger);
    expect(await d("plan:undo", APP_URL, undefined)).toEqual({
      ok: false,
      error: { code: "busy", message: "Slabyrinth is revising the map." },
    });
    const internal = await d("plan:redo", APP_URL, undefined);
    expect(internal).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(JSON.stringify(internal)).not.toContain("SECRET");
    expect(JSON.stringify(logger.records)).not.toContain("SECRETSECRET");
    expect(await d("chat:send", APP_URL, { text: "x" })).toEqual({
      ok: false,
      error: { code: "no_api_key", message: "Add your key." },
    });
    expect(await d("providers:check", APP_URL, { providerId: "anthropic" })).toMatchObject({
      ok: false,
      error: { code: "provider", provider: { kind: "rate_limit" } },
    });
  });

  it("registers exactly the contract channels and validates one-way sends", () => {
    const handled: string[] = [];
    const listeners = new Map<string, (e: IpcEventLike, p: unknown) => void>();
    const results: unknown[] = [];
    registerIpc(
      {
        handle: (c) => {
          handled.push(c);
        },
        on: (c, l) => {
          listeners.set(c, l);
        },
      },
      () => Promise.resolve({ ok: true, value: null }),
      { "render:imageResult": (r) => results.push(r) },
      sendSchemas,
      trusted,
      memoryLogger(),
    );
    expect(handled.sort()).toEqual([...REQUEST_CHANNELS].sort());
    const send = listeners.get("render:imageResult");
    send?.(
      { senderFrame: { url: APP_URL } },
      { requestId: "r1", ok: true, pngBase64: "iVBORw0KGgoAAAANSUhEUg==" },
    );
    send?.(
      { senderFrame: { url: "https://evil.example" } },
      { requestId: "r2", ok: true, pngBase64: "iVBORw0KGgo=" },
    );
    send?.({ senderFrame: { url: APP_URL } }, { requestId: "r3", ok: "yes" });
    expect(results).toEqual([{ requestId: "r1", ok: true, pngBase64: "iVBORw0KGgoAAAANSUhEUg==" }]);
  });
});
