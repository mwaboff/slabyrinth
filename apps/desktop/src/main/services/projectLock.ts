import * as fsp from "node:fs/promises";
import * as os from "node:os";

/**
 * Single-writer lock (architecture §6.4): a sidecar `<file>.lock` holding pid and host, created
 * with O_EXCL. A lock whose process is gone (same host) is stale and taken over. A live lock from
 * another process, or one from another computer (shared folder), is reported as a conflict.
 */
export interface LockInfo {
  app: "slabyrinth";
  pid: number;
  host: string;
  at: string;
}

export interface LockEnv {
  pid: number;
  host: string;
  isPidAlive: (pid: number) => boolean;
}

export const defaultLockEnv = (): LockEnv => ({
  pid: process.pid,
  host: os.hostname(),
  isPidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
});

export type AcquireResult = { ok: true; lock: ProjectLock } | { ok: false; holder: LockInfo };

export const lockPathFor = (file: string): string => `${file}.lock`;

export class ProjectLock {
  private constructor(
    private file: string,
    private readonly info: LockInfo,
  ) {}

  get path(): string {
    return lockPathFor(this.file);
  }

  static async acquire(
    file: string,
    env: LockEnv = defaultLockEnv(),
    opts: { force?: boolean } = {},
  ): Promise<AcquireResult> {
    const info: LockInfo = { app: "slabyrinth", pid: env.pid, host: env.host, at: new Date().toISOString() };
    const lockFile = lockPathFor(file);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fsp.writeFile(lockFile, JSON.stringify(info), { flag: "wx" });
        return { ok: true, lock: new ProjectLock(file, info) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const holder = await readLock(lockFile);
      const stale =
        holder === null ||
        (holder.host === env.host && (holder.pid === env.pid || !env.isPidAlive(holder.pid))) ||
        opts.force === true;
      if (!stale) return { ok: false, holder };
      await fsp.unlink(lockFile).catch(() => undefined);
    }
    // Lost a race twice: report the current holder.
    const holder = (await readLock(lockFile)) ?? info;
    return { ok: false, holder };
  }

  /** Follows a rename of the project file. */
  async moveTo(newFile: string): Promise<void> {
    const from = lockPathFor(this.file);
    const to = lockPathFor(newFile);
    await fsp.writeFile(to, JSON.stringify(this.info), { flag: "w" });
    await fsp.unlink(from).catch(() => undefined);
    this.file = newFile;
  }

  async release(): Promise<void> {
    const current = await readLock(lockPathFor(this.file));
    if (current && (current.pid !== this.info.pid || current.host !== this.info.host)) return; // taken over
    await fsp.unlink(lockPathFor(this.file)).catch(() => undefined);
  }

  /** Synchronous best-effort release for process exit. */
  releaseSync(unlinkSync: (p: string) => void): void {
    try {
      unlinkSync(lockPathFor(this.file));
    } catch {
      // ignore
    }
  }
}

async function readLock(file: string): Promise<LockInfo | null> {
  try {
    const v = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<LockInfo>;
    if (typeof v.pid === "number" && typeof v.host === "string") {
      return { app: "slabyrinth", pid: v.pid, host: v.host, at: typeof v.at === "string" ? v.at : "" };
    }
    return null;
  } catch {
    return null;
  }
}
