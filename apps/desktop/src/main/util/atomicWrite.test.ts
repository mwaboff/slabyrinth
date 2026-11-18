import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempFiles, nodeAtomicFs, writeFileAtomic, type AtomicFs } from "./atomicWrite";

class Crash extends Error {}

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "slab-atomic-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

/**
 * An AtomicFs that "crashes" (throws, and stops doing anything) at the k-th file-system step.
 * When the crash lands on a write it first writes HALF of the requested bytes: a torn write.
 */
function crashingFs(crashAt: number): AtomicFs & { steps: () => number } {
  let step = 0;
  let dead = false;
  const tick = (): boolean => {
    if (dead) throw new Crash("dead");
    if (step++ === crashAt) {
      dead = true;
      return true;
    }
    return false;
  };
  return {
    steps: () => step,
    open: async (p, flags) => {
      if (tick()) throw new Crash("open");
      const fh = await fsp.open(p, flags);
      return {
        write: async (buf, off, len, pos) => {
          if (tick()) {
            await fh.write(buf, off, Math.max(1, Math.floor(len / 2)), pos);
            throw new Crash("torn write");
          }
          return fh.write(buf, off, len, pos);
        },
        sync: async () => {
          if (tick()) throw new Crash("fsync");
          await fh.sync();
        },
        close: async () => {
          await fh.close();
        },
      };
    },
    rename: async (a, b) => {
      if (tick()) throw new Crash("rename");
      await fsp.rename(a, b);
    },
    copyFile: async (a, b) => {
      if (tick()) {
        // torn backup copy
        const data = await fsp.readFile(a);
        await fsp.writeFile(b, data.subarray(0, data.length >> 1));
        throw new Crash("copy");
      }
      await fsp.copyFile(a, b);
    },
    // Cleanup after a crash would not run in a real crash: make it a no-op once dead.
    unlink: async (p) => {
      if (!dead) await fsp.unlink(p);
    },
    exists: (p) => nodeAtomicFs.exists(p),
  };
}

const doc = (tag: string, size: number): string => JSON.stringify({ tag, data: tag.repeat(size) });

describe("writeFileAtomic", () => {
  it("writes, replaces and keeps a .bak of the previous version", async () => {
    const f = path.join(dir, "a.slabyrinth");
    await writeFileAtomic(f, "one", { backup: true });
    await writeFileAtomic(f, "two", { backup: true });
    expect(await fsp.readFile(f, "utf8")).toBe("two");
    expect(await fsp.readFile(`${f}.bak`, "utf8")).toBe("one");
    expect((await fsp.readdir(dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("CRASH SAFETY: interrupted at every step, the file is always the complete old or new version", async () => {
    const f = path.join(dir, "p.slabyrinth");
    const oldDoc = doc("old", 20_000);
    const newDoc = doc("new", 30_000);
    let k = 0;
    let completedRuns = 0;
    let crashes = 0;
    for (; k < 500; k++) {
      await fsp.writeFile(f, oldDoc);
      await fsp.rm(`${f}.bak`, { force: true });
      const cfs = crashingFs(k);
      let crashed = false;
      try {
        // 1 KB chunks → dozens of interruption points inside the data write alone.
        await writeFileAtomic(f, newDoc, { backup: true, fs: cfs, chunkSize: 1024 });
      } catch (err) {
        expect(err).toBeInstanceOf(Crash);
        crashed = true;
        crashes += 1;
      }
      const now = await fsp.readFile(f, "utf8");
      expect([oldDoc, newDoc]).toContain(now);
      expect(() => JSON.parse(now) as unknown).not.toThrow();
      if (!crashed) {
        expect(now).toBe(newDoc);
        completedRuns += 1;
        break;
      }
    }
    expect(completedRuns).toBe(1);
    // ~60 interruption points: open, every chunk write (torn), fsync, backup copy, renames.
    expect(crashes).toBeGreaterThan(30);
  });

  it("removes stale temp files left by interrupted writes", async () => {
    const stale = path.join(dir, "x.slabyrinth.tmp-123-4");
    await fsp.writeFile(stale, "junk");
    const old = new Date(Date.now() - 3600_000);
    await fsp.utimes(stale, old, old);
    expect(await cleanupTempFiles(dir)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("CRASH SAFETY: kill -9 of a writing process never leaves a torn file", async () => {
    const require = createRequire(import.meta.url);
    let tsxEntry: string;
    try {
      tsxEntry = require.resolve("tsx");
    } catch {
      return; // tsx not installed: the in-process fault injection above still covers every step
    }
    const child = fileURLToPath(new URL("./testing/atomicWriter.child.ts", import.meta.url));
    const target = path.join(dir, "killed.slabyrinth");
    const verify = (text: string): number => {
      const outer = JSON.parse(text) as { sha: string; body: string };
      expect(createHash("sha256").update(outer.body).digest("hex")).toBe(outer.sha);
      return (JSON.parse(outer.body) as { n: number }).n;
    };
    let kills = 0;
    for (let round = 0; round < 8; round++) {
      const proc = spawn(process.execPath, ["--import", pathToImport(tsxEntry), child, target], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise<void>((resolve, reject) => {
        proc.stdout.on("data", (d: Buffer) => {
          if (d.toString().includes("READY")) resolve();
        });
        proc.on("exit", (code) => {
          reject(new Error(`child exited early (${String(code)})`));
        });
      });
      await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 400)));
      proc.kill("SIGKILL");
      await new Promise((r) => proc.once("exit", r));
      kills += 1;
      if (fs.existsSync(target)) verify(await fsp.readFile(target, "utf8"));
      if (fs.existsSync(`${target}.bak`)) verify(await fsp.readFile(`${target}.bak`, "utf8"));
    }
    expect(kills).toBe(8);
    expect(fs.existsSync(target)).toBe(true);
  }, 120_000);
});

function pathToImport(entry: string): string {
  // tsx's package entry resolves to dist/cjs; the ESM loader hook is the package root import "tsx".
  return entry.includes(`${path.sep}node_modules${path.sep}tsx${path.sep}`) ? "tsx" : entry;
}
