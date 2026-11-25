/**
 * `--jobs <n>`: renders in worker threads. Job k goes to worker k mod n (a fixed split, so which thread drew a picture
 * never depends on timing); each worker opens the meshes once, from the cache the parent warmed and at the install the
 * parent found (it never looks for TaleSpire or reads a bundle itself), and posts back each render's record. The caller
 * sorts the records by job, so the run's index is the same whatever the threads' speed. Worker messages to the console
 * (progress lines) are passed through as they come. When one worker fails, every other is stopped.
 */
import { Worker } from "node:worker_threads";
import type { Io, RenderEnv } from "./render3d";
import type { Job, JobOutput } from "./job";

export interface WorkerData {
  argv: string[];
  /** What a worker's runner reads (data only: a function cannot go to a thread). */
  env: Pick<RenderEnv, "cwd" | "appData" | "coldRead">;
  out: string;
  jobs: Job[];
  /** The TaleSpire folder the parent found (null: none), so the worker never looks for it. */
  install: string | null;
}

export type WorkerMessage =
  { kind: "log"; text: string } | { kind: "done"; output: JobOutput } | { kind: "error"; message: string };

/** What the batch needs of a render thread (a Node Worker, or a test's stand-in). */
export interface WorkerHandle {
  on(event: "message", f: (m: WorkerMessage) => void): unknown;
  on(event: "error", f: (e: Error) => void): unknown;
  on(event: "exit", f: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export type SpawnWorker = (data: WorkerData) => WorkerHandle;

/** A Node worker thread running worker.ts. */
export const nodeWorker: SpawnWorker = (data) =>
  new Worker(new URL("./worker.ts", import.meta.url), { workerData: data, execArgv: process.execArgv });

/** Splits jobs over `n` threads: job k to thread k mod n. */
export function splitJobs<T>(jobs: readonly T[], n: number): T[][] {
  const out: T[][] = Array.from({ length: n }, () => []);
  jobs.forEach((j, k) => out[k % n]?.push(j));
  return out.filter((l) => l.length > 0);
}

export async function runJobsInWorkers(
  jobs: readonly Job[],
  threads: number,
  base: Omit<WorkerData, "jobs">,
  io: Io,
  spawn: SpawnWorker = nodeWorker,
): Promise<{ outputs: JobOutput[] }> {
  const outputs: JobOutput[] = [];
  const handles: WorkerHandle[] = [];
  try {
    await Promise.all(
      splitJobs(jobs, threads).map(
        (share) =>
          new Promise<void>((resolveRun, reject) => {
            const w = spawn({ ...base, jobs: share });
            handles.push(w);
            w.on("message", (m: WorkerMessage) => {
              if (m.kind === "log") io.err(m.text);
              else if (m.kind === "done") outputs.push(m.output);
              else reject(new Error(m.message));
            });
            w.on("error", reject);
            w.on("exit", (code) => {
              if (code === 0) resolveRun();
              else reject(new Error(`a render thread stopped (exit ${String(code)})`));
            });
          }),
      ),
    );
  } finally {
    // after a failure the others would keep rendering and writing pictures, and keep the process alive: stop them all
    // (a thread that already finished stops at once)
    await Promise.allSettled(handles.map((h) => h.terminate()));
  }
  return { outputs };
}
