import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IpcRequests } from "../../shared/ipc";
import type { AppSettings } from "../../shared/project";
import { memoryLogger } from "../logger";
import type { ConversationEngine } from "../ports/engine";
import type { Dialogs } from "../services/dialogs";
import { SecretStore, type SafeStorageLike } from "../services/secretStore";
import { createHandlers, type HandlerServices } from "./handlers";

/** dialog:pickFolder: the only folder picker the renderer gets, for two purposes. */
function rig(picked: string | null) {
  const asked: Array<{ title: string; defaultPath?: string }> = [];
  const dialogs: Dialogs = {
    openFile: () => Promise.resolve(null),
    saveFile: () => Promise.resolve(null),
    chooseFolder: (o) => {
      asked.push(o);
      return Promise.resolve(picked);
    },
    confirm: () => Promise.resolve(false),
  };
  const settings = {
    get: () =>
      ({
        talespire: { installPath: "C:\\Steam\\TaleSpire" },
        projects: { folder: "C:\\Users\\gm\\Documents\\Slabyrinth" },
      }) as AppSettings,
  };
  const talespire = {
    checkInstall: (dir: string) =>
      Promise.resolve(
        dir.endsWith("TaleSpire")
          ? { path: dir, valid: true as const }
          : { path: dir, valid: false as const, reason: "not_talespire" as const, message: "Not TaleSpire." },
      ),
  };
  const services = { settings, dialogs, talespire, logger: memoryLogger() } as unknown as HandlerServices;
  return { handlers: createHandlers(services), asked };
}

describe("dialog:pickFolder", () => {
  it("talespire: validates the picked folder with the install rule", async () => {
    const ok = rig("D:\\Games\\TaleSpire");
    expect(await ok.handlers["dialog:pickFolder"]({ purpose: "talespire" })).toEqual({
      path: "D:\\Games\\TaleSpire",
      valid: true,
    });
    expect(ok.asked[0]?.defaultPath).toBe("C:\\Steam\\TaleSpire");
    const bad = rig("D:\\Games");
    expect(await bad.handlers["dialog:pickFolder"]({ purpose: "talespire" })).toEqual({
      path: "D:\\Games",
      valid: false,
      reason: "not_talespire",
      message: "Not TaleSpire.",
    });
  });

  it("projects: returns the folder; cancel returns null", async () => {
    const r = rig("E:\\Maps");
    expect(await r.handlers["dialog:pickFolder"]({ purpose: "projects" })).toEqual({
      path: "E:\\Maps",
      valid: true,
    });
    expect(r.asked[0]?.defaultPath).toBe("C:\\Users\\gm\\Documents\\Slabyrinth");
    expect(await rig(null).handlers["dialog:pickFolder"]({ purpose: "projects" })).toBeNull();
  });
});

describe("secrets:setApiKey with verify (store, check, drop a rejected key)", () => {
  const KEY = "sk-ant-api03-TESTKEY-not-real-0000000000-z9Y8";
  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
  };
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "slab-verify-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  function keyRig(check: IpcRequests["providers:check"]["res"] | Error) {
    const file = path.join(dir, "secret.bin");
    const secrets = new SecretStore({
      file,
      safeStorage,
      platform: "win32",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    const engine = {
      checkProvider: () => (check instanceof Error ? Promise.reject(check) : Promise.resolve(check)),
    } as unknown as ConversationEngine;
    const services = { secrets, engine: () => engine, logger: memoryLogger() } as unknown as HandlerServices;
    return { handlers: createHandlers(services), secrets, file };
  }

  it("an auth rejection removes the key from memory and secret.bin", async () => {
    const auth = {
      kind: "auth",
      retryable: false,
      httpStatus: 401,
      message: "Your API key was rejected.",
    } as const;
    const r = keyRig({ ok: false, error: auth });
    const res = await r.handlers["secrets:setApiKey"]({ providerId: "anthropic", apiKey: KEY, verify: true });
    expect(res).toMatchObject({ stored: false, check: { ok: false, error: { kind: "auth" } } });
    expect((await r.secrets.status())["anthropic"]).toEqual({ hasKey: false, backend: null, hint: null });
    expect(await r.secrets.getApiKey("anthropic")).toBeNull();
    const onDisk = JSON.parse(await fsp.readFile(r.file, "utf8")) as { entries: Record<string, unknown> };
    expect(onDisk.entries).toEqual({});
  });

  it("a network failure (or a failing check) keeps the key; an OK check keeps it too", async () => {
    const net = { kind: "network", retryable: true, message: "Connection lost." } as const;
    // an "auth" answer that did not come from the provider rejecting the key (no 401) keeps it too
    const notFromProvider = { kind: "auth", retryable: false, message: "No key." } as const;
    for (const check of [
      { ok: false as const, error: net },
      { ok: false as const, error: notFromProvider },
      new Error("engine down"),
      { ok: true as const },
    ]) {
      const r = keyRig(check);
      const res = await r.handlers["secrets:setApiKey"]({
        providerId: "anthropic",
        apiKey: KEY,
        verify: true,
      });
      expect(res.stored).toBe(true);
      expect(res.check?.ok).toBe(check instanceof Error ? false : check.ok);
      expect((await r.secrets.status())["anthropic"].hasKey).toBe(true);
      await r.secrets.clearApiKey("anthropic");
    }
  });

  it("without verify, nothing is checked", async () => {
    const r = keyRig(new Error("must not be called"));
    expect(await r.handlers["secrets:setApiKey"]({ providerId: "anthropic", apiKey: KEY })).toEqual({
      stored: true,
      backend: "os",
    });
  });
});
