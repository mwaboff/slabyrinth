import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ProviderId } from "../agent/provider/types";
import type { Logger } from "../logger";
import { writeFileAtomic, type AtomicFs } from "../util/atomicWrite";
import { AppFailure } from "../util/errors";

/**
 * SecretStore (architecture §6.5, UX §8.3): API keys encrypted with Electron safeStorage
 * (DPAPI on Windows, libsecret/kwallet on Linux) in userData/secret.bin, one entry per provider.
 * Keys are decrypted only in main, on demand (`getApiKey`). The renderer only ever learns
 * `hasKey`, the storage backend and a masked hint ("sk-ant-…a1B2").
 *
 * Linux without a keyring (safeStorage backend "basic_text"): the default is "memory only" — the
 * key is kept for this session and never written. Storing with weak protection requires an explicit
 * `storage: "allow_weak"` (UX "Store anyway").
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only in Electron. */
  getSelectedStorageBackend?: () => string;
}

export type SecretBackend = "os" | "basic_text" | "memory_only";
export type SecretStorageChoice = "auto" | "allow_weak" | "memory_only";

const fileSchema = z.object({
  schema: z.literal("slabyrinth/secrets@1"),
  entries: z.record(z.string(), z.object({ backend: z.enum(["os", "basic_text"]), data: z.string() })),
});
type SecretFile = z.infer<typeof fileSchema>;

export interface SecretStatus {
  hasKey: boolean;
  backend: SecretBackend | null;
  /** Masked hint for display; never enough to reconstruct the key. */
  hint: string | null;
  /** A key is saved but can't be decrypted (keyring changed or reset); `hasKey` is false. */
  unreadable?: true;
  /** Memory-only key that `storeWeak` could persist with weak protection (Linux without a keyring). */
  weakAvailable?: true;
}

/** secret.bin and its temp file: owner read/write only on POSIX (decisions.md "secret.bin file mode"). */
export const SECRET_FILE_MODE = 0o600;

export function maskKey(key: string): string {
  const prefix = /^(sk-[a-z]+-)/i.exec(key)?.[1] ?? key.slice(0, 3);
  return key.length <= 12 ? `${prefix}…` : `${prefix}…${key.slice(-4)}`;
}

export const apiKeySchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(8)
      .max(512)
      .regex(/^[\x21-\x7E]+$/, "API keys contain no spaces or control characters"),
  );

export interface SecretStoreOptions {
  file: string;
  safeStorage: SafeStorageLike;
  platform: NodeJS.Platform;
  logger: Logger;
  knownProviders: ProviderId[];
  /** File-system seam for tests (defaults to node:fs). */
  fs?: AtomicFs;
}

export class SecretStore {
  private readonly memory = new Map<ProviderId, string>();
  /** Masked hints of stored keys (memory only, never written): `status()` doesn't decrypt each time. */
  private readonly hints = new Map<ProviderId, string>();
  /** Providers whose stored blob failed to decrypt; retried only by `getApiKey`. */
  private readonly unreadable = new Set<ProviderId>();
  private cache: SecretFile | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SecretStoreOptions) {}

  /** What persistent protection is available right now. */
  persistentBackend(): "os" | "basic_text" | "unavailable" {
    const ss = this.opts.safeStorage;
    if (!ss.isEncryptionAvailable()) return "unavailable";
    if (this.opts.platform === "linux") {
      const b = ss.getSelectedStorageBackend?.() ?? "unknown";
      if (b === "basic_text" || b === "unknown") return "basic_text";
    }
    return "os";
  }

  async setApiKey(
    providerId: ProviderId,
    apiKey: string,
    storage: SecretStorageChoice = "auto",
  ): Promise<{ stored: boolean; backend: SecretBackend; weakAvailable?: true }> {
    const parsed = apiKeySchema.safeParse(apiKey);
    if (!parsed.success) throw new AppFailure("validation", "That doesn't look like an API key.");
    const key = parsed.data;
    const available = this.persistentBackend();
    const backend: SecretBackend =
      storage === "memory_only" ||
      available === "unavailable" ||
      (available === "basic_text" && storage !== "allow_weak")
        ? "memory_only"
        : available;

    return this.serialize(async () => {
      const file = await this.read();
      // A new key replaces whatever was stored, including a stale blob that no longer decrypts.
      const remember = (): void => {
        this.unreadable.delete(providerId);
        this.hints.set(providerId, maskKey(key));
      };
      if (backend === "memory_only") {
        this.memory.set(providerId, key);
        remember();
        if (providerId in file.entries) {
          Reflect.deleteProperty(file.entries, providerId);
          await this.write(file);
        }
        this.opts.logger.info("api key kept in memory only", { providerId });
        return available === "basic_text"
          ? { stored: false, backend, weakAvailable: true }
          : { stored: false, backend };
      }
      const data = this.opts.safeStorage.encryptString(key).toString("base64");
      file.entries[providerId] = { backend, data };
      await this.write(file);
      this.memory.delete(providerId);
      remember();
      this.opts.logger.info("api key stored", { providerId, backend });
      return { stored: true, backend };
    });
  }

  /**
   * UX "Store anyway (less secure)": persists the session-only key with the best protection available (weak on
   * Linux without a keyring). The key comes from main's memory; the renderer never sends it again.
   */
  async storeWeak(providerId: ProviderId): Promise<{ stored: boolean; backend: SecretBackend }> {
    const key = this.memory.get(providerId);
    if (key === undefined) throw new AppFailure("validation", "There is no session key to store. Enter it again.");
    const { stored, backend } = await this.setApiKey(providerId, key, "allow_weak");
    return { stored, backend };
  }

  async clearApiKey(providerId: ProviderId): Promise<void> {
    await this.serialize(async () => {
      this.memory.delete(providerId);
      this.hints.delete(providerId);
      this.unreadable.delete(providerId);
      const file = await this.read();
      if (providerId in file.entries) {
        Reflect.deleteProperty(file.entries, providerId);
        await this.write(file);
      }
      this.opts.logger.info("api key cleared", { providerId });
    });
  }

  /** MAIN ONLY. Never pass the result to the renderer, logs or project files. */
  async getApiKey(providerId: ProviderId): Promise<string | null> {
    const mem = this.memory.get(providerId);
    if (mem !== undefined) return mem;
    const file = await this.read();
    const entry = file.entries[providerId];
    if (!entry) return null;
    try {
      const key = this.opts.safeStorage.decryptString(Buffer.from(entry.data, "base64"));
      this.unreadable.delete(providerId);
      this.hints.set(providerId, maskKey(key));
      return key;
    } catch (err) {
      this.opts.logger.warn("api key could not be decrypted (keyring changed?)", { providerId, error: err });
      this.unreadable.add(providerId);
      this.hints.delete(providerId);
      return null;
    }
  }

  async status(): Promise<Record<ProviderId, SecretStatus>> {
    const file = await this.read();
    const ids = new Set<ProviderId>([
      ...this.opts.knownProviders,
      ...Object.keys(file.entries),
      ...this.memory.keys(),
    ]);
    const out = {} as Record<ProviderId, SecretStatus>;
    for (const id of ids) {
      const mem = this.memory.get(id);
      const entry = file.entries[id];
      if (mem !== undefined) {
        out[id] =
          this.persistentBackend() === "basic_text"
            ? { hasKey: true, backend: "memory_only", hint: maskKey(mem), weakAvailable: true }
            : { hasKey: true, backend: "memory_only", hint: maskKey(mem) };
      } else if (entry) {
        // Decrypt only the first time (to learn the hint, or that the blob is unreadable); then use the cache.
        if (!this.hints.has(id) && !this.unreadable.has(id)) await this.getApiKey(id);
        const hint = this.hints.get(id);
        out[id] =
          hint !== undefined
            ? { hasKey: true, backend: entry.backend, hint }
            : { hasKey: false, backend: entry.backend, hint: null, unreadable: true };
      } else {
        out[id] = { hasKey: false, backend: null, hint: null };
      }
    }
    return out;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(fn);
    this.chain = next;
    return next;
  }

  private async read(): Promise<SecretFile> {
    if (this.cache) return this.cache;
    try {
      const raw: unknown = JSON.parse(await fsp.readFile(this.opts.file, "utf8"));
      const parsed = fileSchema.safeParse(raw);
      this.cache = parsed.success ? parsed.data : { schema: "slabyrinth/secrets@1", entries: {} };
      if (!parsed.success) this.opts.logger.warn("secret.bin unreadable; treating as empty");
    } catch {
      this.cache = { schema: "slabyrinth/secrets@1", entries: {} };
    }
    return this.cache;
  }

  private async write(file: SecretFile): Promise<void> {
    this.cache = file;
    await fsp.mkdir(path.dirname(this.opts.file), { recursive: true });
    await writeFileAtomic(this.opts.file, JSON.stringify(file), {
      mode: SECRET_FILE_MODE,
      ...(this.opts.fs ? { fs: this.opts.fs } : {}),
    });
  }
}
