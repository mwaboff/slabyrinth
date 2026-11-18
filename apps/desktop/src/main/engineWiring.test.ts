import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The SDK is mocked: these tests must never reach the network.
const sdk = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
  listed: 0,
}));
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  // Keep the real error classes (the provider maps them); replace only the client.
  const actual = await importOriginal<Record<string, unknown>>();
  class Anthropic {
    readonly beta = {
      messages: {
        stream: () => {
          throw new Error("no network in tests");
        },
      },
    };
    readonly models = {
      list: () => ({
        [Symbol.asyncIterator]: () => {
          sdk.listed++;
          return { next: () => Promise.resolve({ done: true as const, value: undefined }) };
        },
      }),
    };
    constructor(opts: Record<string, unknown>) {
      sdk.constructed.push(opts);
    }
  }
  return { ...actual, default: Anthropic, Anthropic };
});

import { SlabyrinthConversationEngine } from "./agent";
import { ANTHROPIC_INFO } from "./agent/provider/anthropic/provider";
import { MemoryHost, newProject } from "./agent/testing/memoryHost";
import { engineKindFor, resolveApiKey, selectEngine } from "./engineWiring";
import { memoryLogger } from "./logger";
import { EnginePortError } from "./ports/engine";
import { SecretStore, type SafeStorageLike } from "./services/secretStore";

const KEY = "sk-ant-api03-TESTKEY-not-real-0000000000-z9Y8";

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "slab-wiring-"));
  sdk.constructed.length = 0;
  sdk.listed = 0;
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function secretStore(): SecretStore {
  return new SecretStore({
    file: path.join(dir, "secret.bin"),
    safeStorage: fakeSafeStorage,
    platform: "win32",
    logger: memoryLogger(),
    knownProviders: ["anthropic"],
  });
}

/** MemoryHost whose API key comes from the SecretStore, as main/app.ts wires it. */
function hostWith(secrets: SecretStore): MemoryHost {
  const host = new MemoryHost(newProject());
  host.getApiKey = (id?: string) => secrets.getApiKey(id ?? "anthropic");
  return host;
}

describe("engine selection", () => {
  const base = { isDev: false, safeMode: false, env: {}, fakeEngineFlag: false };

  it("uses the real engine by default, in packaged and dev builds", () => {
    expect(engineKindFor(base)).toBe("real");
    expect(engineKindFor({ ...base, isDev: true })).toBe("real");
    expect(engineKindFor({ ...base, safeMode: true })).toBe("real");
  });

  it("selects the fake engine only behind an explicit dev/test switch", () => {
    const fakeEnv = { SLABYRINTH_FAKE_ENGINE: "1" };
    expect(engineKindFor({ ...base, env: fakeEnv })).toBe("real"); // packaged: ignored
    expect(engineKindFor({ ...base, fakeEngineFlag: true })).toBe("real"); // packaged: ignored
    expect(engineKindFor({ ...base, isDev: true, env: fakeEnv })).toBe("fake");
    expect(engineKindFor({ ...base, isDev: true, fakeEngineFlag: true })).toBe("fake");
    expect(engineKindFor({ ...base, safeMode: true, env: fakeEnv })).toBe("fake");
  });

  it("registers a scripted provider only in test runs of test builds", () => {
    const env = { SLABYRINTH_E2E_PROVIDER_SCRIPT: "steps.json" };
    expect(engineKindFor({ ...base, env }, true)).toBe("real");
    expect(engineKindFor({ ...base, isDev: true, env }, true)).toBe("real");
    expect(engineKindFor({ ...base, safeMode: true, env }, true)).toBe("scripted");
    // Production bundles (out/, packaged) have no scripted provider at all.
    expect(engineKindFor({ ...base, safeMode: true, env }, false)).toBe("real");
  });
});

describe("API key resolution (stored key vs ANTHROPIC_API_KEY)", () => {
  const ENV_KEY = "sk-ant-api03-ENV-not-real-222222222222-q1Q1";
  const env = { ANTHROPIC_API_KEY: ENV_KEY };

  it("ignores the environment key in packaged builds and in safe (e2e/smoke) mode", () => {
    expect(resolveApiKey(null, "anthropic", { isDev: false, safeMode: false, env })).toBeNull();
    expect(resolveApiKey(null, "anthropic", { isDev: false, safeMode: true, env })).toBeNull();
    expect(resolveApiKey(null, "anthropic", { isDev: true, safeMode: true, env })).toBeNull();
  });

  it("in dev, a stored key beats the environment; the environment is only a fallback for Anthropic", () => {
    expect(resolveApiKey(KEY, "anthropic", { isDev: true, safeMode: false, env })).toBe(KEY);
    expect(resolveApiKey(null, "anthropic", { isDev: true, safeMode: false, env })).toBe(ENV_KEY);
    expect(resolveApiKey(null, "lmstudio", { isDev: true, safeMode: false, env })).toBeNull();
    expect(
      resolveApiKey(null, "anthropic", { isDev: true, safeMode: false, env: { ANTHROPIC_API_KEY: " " } }),
    ).toBeNull();
    expect(resolveApiKey(KEY, "anthropic", { isDev: false, safeMode: true, env })).toBe(KEY);
  });
});

describe("real engine wiring", () => {
  it("registers the AnthropicProvider by default and builds the SDK client with the stored key", async () => {
    const secrets = secretStore();
    await secrets.setApiKey("anthropic", KEY, "auto");
    const selected = await selectEngine({
      isDev: false,
      safeMode: false,
      env: { SLABYRINTH_FAKE_ENGINE: "1" },
      fakeEngineFlag: true,
      applyOps: null,
    });
    expect(selected.kind).toBe("real");
    const host = hostWith(secrets);
    const engine = selected.factory(host);
    expect(engine).toBeInstanceOf(SlabyrinthConversationEngine);

    const providers = await engine.listProviders();
    expect(providers.map((p) => p.id)).toEqual(["anthropic"]);
    expect(providers[0]).toMatchObject({ ...ANTHROPIC_INFO, enabled: true });

    expect(sdk.constructed).toHaveLength(0); // no client until it is needed
    expect(await engine.checkProvider("anthropic")).toEqual({ ok: true });
    expect(sdk.constructed).toHaveLength(1);
    expect(sdk.constructed[0]).toMatchObject({
      apiKey: KEY,
      authToken: null,
      baseURL: "https://api.anthropic.com",
      maxRetries: 2,
    });
    expect(sdk.listed).toBe(1);
    // The key never reaches events or logs.
    expect(JSON.stringify(host.events)).not.toContain(KEY);
  });

  it("reports a missing key as the typed no_api_key state, without building a client", async () => {
    const host = hostWith(secretStore());
    const engine = (
      await selectEngine({ isDev: false, safeMode: false, env: {}, fakeEngineFlag: false, applyOps: null })
    ).factory(host);
    const err = await engine.send({ text: "a crypt" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnginePortError);
    expect((err as EnginePortError).error.code).toBe("no_api_key");
    expect(await engine.checkProvider("anthropic")).toMatchObject({ ok: false, error: { kind: "auth" } });
    // The model picker still works offline from the bundled table.
    expect((await engine.listModels("anthropic", false)).length).toBeGreaterThan(0);
    expect(sdk.constructed).toHaveLength(0);
  });
});
