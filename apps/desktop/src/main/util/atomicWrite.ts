import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isNodeError } from "./errors";

/**
 * Crash-safe file replacement (architecture §6.4):
 *   1. write `<file>.tmp-<pid>-<n>` in chunks, fsync, close;
 *   2. (optional) rotate the current good file to `<file>.bak` (copy to a temp, then rename);
 *   3. rename the temp over the target — atomic on the same volume (POSIX rename(2); Windows
 *      MoveFileEx with REPLACE_EXISTING), retried briefly on transient Windows sharing errors;
 *   4. fsync the directory (POSIX).
 * At every instant the target is either the old complete file or the new complete file.
 * The file-system operations are injectable so tests can interrupt the sequence at any point.
 */
export interface AtomicFileHandle {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicFs {
  /** `mode` applies only when the file is created (POSIX permission bits; ignored on Windows). */
  open(path: string, flags: "w" | "wx" | "r", mode?: number): Promise<AtomicFileHandle>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export const nodeAtomicFs: AtomicFs = {
  open: (p, flags, mode) => fsp.open(p, flags, mode),
  rename: (a, b) => fsp.rename(a, b),
  copyFile: (a, b) => fsp.copyFile(a, b),
  unlink: (p) => fsp.unlink(p),
  exists: async (p) => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
};

export interface AtomicWriteOptions {
  /** Keep the previous good copy as `<file>.bak`. */
  backup?: boolean;
  fs?: AtomicFs;
  /** Write chunk size (bytes). */
  chunkSize?: number;
  platform?: NodeJS.Platform;
  /** Permission bits for the temp file, which the rename makes the target (e.g. 0o600 for secrets). */
  mode?: number;
}

let tmpCounter = 0;

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameWithRetry(
  fs: AtomicFs,
  from: string,
  to: string,
  platform: NodeJS.Platform,
): Promise<void> {
  // Antivirus / indexers on Windows briefly hold files open; retry for up to ~1 s.
  const attempts = platform === "win32" ? 10 : 1;
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      if (i + 1 >= attempts || !isNodeError(err) || !TRANSIENT.has(err.code ?? "")) throw err;
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
}

async function writeWhole(
  fs: AtomicFs,
  file: string,
  data: Uint8Array,
  chunkSize: number,
  mode: number | undefined,
): Promise<void> {
  const fh = await (mode === undefined ? fs.open(file, "wx") : fs.open(file, "wx", mode));
  try {
    let off = 0;
    while (off < data.length) {
      const len = Math.min(chunkSize, data.length - off);
      const { bytesWritten } = await fh.write(data, off, len, off);
      if (bytesWritten <= 0) throw new Error("short write");
      off += bytesWritten;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function writeFileAtomic(
  file: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const fs = options.fs ?? nodeAtomicFs;
  const platform = options.platform ?? process.platform;
  const chunkSize = options.chunkSize ?? 64 * 1024;
  const data = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  tmpCounter += 1;
  const tmp = `${file}.tmp-${String(process.pid)}-${String(tmpCounter)}`;

  try {
    await writeWhole(fs, tmp, data, chunkSize, options.mode);

    if (options.backup === true && (await fs.exists(file))) {
      const bakTmp = `${file}.bak.tmp-${String(process.pid)}-${String(tmpCounter)}`;
      try {
        await fs.copyFile(file, bakTmp);
        await renameWithRetry(fs, bakTmp, `${file}.bak`, platform);
      } catch (err) {
        await fs.unlink(bakTmp).catch(() => undefined);
        // A failed backup must not block saving the new version.
        if (!isNodeError(err)) throw err;
      }
    }

    await renameWithRetry(fs, tmp, file, platform);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }

  if (platform !== "win32" && fs === nodeAtomicFs) {
    // Persist the directory entry (rename) itself.
    try {
      const dir = await fsp.open(path.dirname(file), "r");
      await dir.sync().catch(() => undefined);
      await dir.close();
    } catch {
      // Not all file systems allow opening directories.
    }
  }
}

/** Removes stale `<file>.tmp-*` leftovers of interrupted writes in a folder (best effort). */
export async function cleanupTempFiles(dir: string, olderThanMs = 60_000): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const name of names) {
    if (!/\.tmp-\d+-\d+$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (now - st.mtimeMs >= olderThanMs) {
        await fsp.unlink(full);
        removed += 1;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}
