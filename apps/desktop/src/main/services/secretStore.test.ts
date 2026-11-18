import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryLogger } from "../logger";
import { nodeAtomicFs, type AtomicFs } from "../util/atomicWrite";
import { maskKey, SECRET_FILE_MODE, SecretStore, type SafeStorageLike } from "./secretStore";

const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-a1B2";

/** Electron safeStorage double: reversible "encryption" that never contains the plaintext. */
function fakeSafeStorage(opts: { available?: boolean; backend?: string } = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => opts.available ?? true,
    encryptString: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
    ...(opts.backend !== undefined ? { getSelectedStorageBackend: () => opts.backend as string } : {}),
  };
}

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "slab-secret-"));
  file = path.join(dir, "secret.bin");
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("SecretStore", () => {
  it("encrypts with the OS backend; the file and the log never contain the key", async () => {
    const logger = memoryLogger();
    const store = new SecretStore({
      file,
      safeStorage: fakeSafeStorage(),
      platform: "win32",
      logger,
      knownProviders: ["anthropic"],
    });
    expect(await store.setApiKey("anthropic", `  ${KEY}\n`)).toEqual({ stored: true, backend: "os" });
    const raw = await fsp.readFile(file, "utf8");
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("a1B2");
    expect(JSON.stringify(logger.records)).not.toContain(KEY);

    const fresh = new SecretStore({
      file,
      safeStorage: fakeSafeStorage(),
      platform: "win32",
      logger,
      knownProviders: ["anthropic"],
    });
    expect(await fresh.getApiKey("anthropic")).toBe(KEY);
    const status = await fresh.status();
    expect(status["anthropic"]).toEqual({ hasKey: true, backend: "os", hint: "sk-ant-…a1B2" });
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("Linux without a keyring keeps the key in memory only unless the user allows weak storage", async () => {
    const ss = fakeSafeStorage({ backend: "basic_text" });
    const store = new SecretStore({
      file,
      safeStorage: ss,
      platform: "linux",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    expect(store.persistentBackend()).toBe("basic_text");
    expect(await store.setApiKey("anthropic", KEY)).toEqual({
      stored: false,
      backend: "memory_only",
      weakAvailable: true,
    });
    expect(await store.getApiKey("anthropic")).toBe(KEY);
    await expect(fsp.access(file)).rejects.toThrow();
    expect((await store.status())["anthropic"]).toMatchObject({ backend: "memory_only", weakAvailable: true });

    expect(await store.setApiKey("anthropic", KEY, "allow_weak")).toEqual({
      stored: true,
      backend: "basic_text",
    });
    const fresh = new SecretStore({
      file,
      safeStorage: ss,
      platform: "linux",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    expect((await fresh.status())["anthropic"]).toMatchObject({ hasKey: true, backend: "basic_text" });
  });

  it("'Store anyway' persists the session key with weak protection without the renderer re-sending it", async () => {
    const ss = fakeSafeStorage({ backend: "basic_text" });
    const store = new SecretStore({
      file,
      safeStorage: ss,
      platform: "linux",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    await expect(store.storeWeak("anthropic")).rejects.toMatchObject({ code: "validation" });
    await store.setApiKey("anthropic", KEY);
    expect(await store.storeWeak("anthropic")).toEqual({ stored: true, backend: "basic_text" });
    expect(await fsp.readFile(file, "utf8")).not.toContain(KEY);
    const fresh = new SecretStore({
      file,
      safeStorage: ss,
      platform: "linux",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    expect(await fresh.getApiKey("anthropic")).toBe(KEY);
    expect((await fresh.status())["anthropic"]).toEqual({ hasKey: true, backend: "basic_text", hint: "sk-ant-…a1B2" });

    // With no encryption at all, weak storage isn't offered.
    const none = new SecretStore({
      file: path.join(dir, "none.bin"),
      safeStorage: fakeSafeStorage({ available: false }),
      platform: "linux",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    expect(await none.setApiKey("anthropic", KEY)).toEqual({ stored: false, backend: "memory_only" });
    expect((await none.status())["anthropic"].weakAvailable).toBeUndefined();
  });

  it("falls back to memory when encryption is unavailable, and clears keys", async () => {
    const store = new SecretStore({
      file,
      safeStorage: fakeSafeStorage({ available: false }),
      platform: "linux",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    expect((await store.setApiKey("anthropic", KEY)).backend).toBe("memory_only");
    await store.clearApiKey("anthropic");
    expect(await store.getApiKey("anthropic")).toBeNull();
    expect((await store.status())["anthropic"]).toEqual({ hasKey: false, backend: null, hint: null });
  });

  it("rejects values that are not keys", async () => {
    const store = new SecretStore({
      file,
      safeStorage: fakeSafeStorage(),
      platform: "win32",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    await expect(store.setApiKey("anthropic", "short")).rejects.toMatchObject({ code: "validation" });
    await expect(store.setApiKey("anthropic", "sk-ant has spaces inside")).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("reports a stored key that no longer decrypts as unreadable; a new key replaces it, clearing removes it", async () => {
    await new SecretStore({
      file,
      safeStorage: fakeSafeStorage(),
      platform: "win32",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    }).setApiKey("anthropic", KEY);
    // Keyring changed: the old blob can't be decrypted any more.
    const broken: SafeStorageLike = {
      ...fakeSafeStorage(),
      decryptString: () => {
        throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      },
    };
    const store = new SecretStore({
      file,
      safeStorage: broken,
      platform: "win32",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    expect((await store.status())["anthropic"]).toEqual({
      hasKey: false,
      backend: "os",
      hint: null,
      unreadable: true,
    });
    expect(await store.getApiKey("anthropic")).toBeNull();

    const NEW = "sk-ant-api03-NEWKEY-not-real-0000000000-c3D4";
    await store.setApiKey("anthropic", NEW);
    expect((await store.status())["anthropic"]).toEqual({ hasKey: true, backend: "os", hint: "sk-ant-…c3D4" });
    const onDisk = JSON.parse(await fsp.readFile(file, "utf8")) as { entries: Record<string, { data: string }> };
    expect(fakeSafeStorage().decryptString(Buffer.from(onDisk.entries["anthropic"]?.data ?? "", "base64"))).toBe(
      NEW,
    );

    // A second stale blob is removed by clearing.
    const stale = new SecretStore({
      file,
      safeStorage: broken,
      platform: "win32",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    expect((await stale.status())["anthropic"].unreadable).toBe(true);
    await stale.clearApiKey("anthropic");
    expect((await stale.status())["anthropic"]).toEqual({ hasKey: false, backend: null, hint: null });
  });

  it("caches the masked hint: status() decrypts at most once, and never writes the hint", async () => {
    const ss = fakeSafeStorage();
    let decrypts = 0;
    const counting: SafeStorageLike = {
      ...ss,
      decryptString: (b) => {
        decrypts++;
        return ss.decryptString(b);
      },
    };
    await new SecretStore({
      file,
      safeStorage: ss,
      platform: "win32",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    }).setApiKey("anthropic", KEY);
    const store = new SecretStore({
      file,
      safeStorage: counting,
      platform: "win32",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    for (let i = 0; i < 5; i++) expect((await store.status())["anthropic"].hint).toBe("sk-ant-…a1B2");
    expect(decrypts).toBe(1);
    expect(await fsp.readFile(file, "utf8")).not.toContain("a1B2");

    // Storing sets the hint without decrypting; clearing drops it.
    const NEW = "sk-ant-api03-NEWKEY-not-real-0000000000-c3D4";
    await store.setApiKey("anthropic", NEW);
    expect((await store.status())["anthropic"].hint).toBe("sk-ant-…c3D4");
    expect(decrypts).toBe(1);
    await store.clearApiKey("anthropic");
    expect((await store.status())["anthropic"]).toEqual({ hasKey: false, backend: null, hint: null });
  });

  it("creates secret.bin and its temp file with mode 0o600", async () => {
    const opened: Array<{ path: string; flags: string; mode: number | undefined }> = [];
    const recordingFs: AtomicFs = {
      ...nodeAtomicFs,
      open: (p, flags, mode) => {
        opened.push({ path: p, flags, mode });
        return nodeAtomicFs.open(p, flags, mode);
      },
    };
    const store = new SecretStore({
      file,
      safeStorage: fakeSafeStorage({ backend: "gnome_libsecret" }),
      platform: process.platform,
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
      fs: recordingFs,
    });
    await store.setApiKey("anthropic", KEY);
    const writes = opened.filter((o) => o.flags !== "r");
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.path.startsWith(`${file}.tmp-`)).toBe(true);
      expect(w.mode).toBe(SECRET_FILE_MODE);
    }
    expect(SECRET_FILE_MODE).toBe(0o600);
    if (process.platform !== "win32") {
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("clearApiKey removes the entry from secret.bin on disk", async () => {
    const store = new SecretStore({
      file,
      safeStorage: fakeSafeStorage(),
      platform: "win32",
      logger: memoryLogger(),
      knownProviders: ["anthropic", "other"],
    });
    await store.setApiKey("anthropic", KEY);
    await store.setApiKey("other", "sk-other-not-real-0000000000-e5F6");
    const before = JSON.parse(await fsp.readFile(file, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(before.entries).sort()).toEqual(["anthropic", "other"]);
    await store.clearApiKey("anthropic");
    const after = JSON.parse(await fsp.readFile(file, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(after.entries)).toEqual(["other"]);
    const fresh = new SecretStore({
      file,
      safeStorage: fakeSafeStorage(),
      platform: "win32",
      logger: memoryLogger(),
      knownProviders: ["anthropic"],
    });
    expect(await fresh.getApiKey("anthropic")).toBeNull();
  });

  it("masks keys without revealing more than the last 4 characters", () => {
    expect(maskKey(KEY)).toBe("sk-ant-…a1B2");
    expect(maskKey("sk-abc")).toBe("sk-…");
  });
});
