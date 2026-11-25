/**
 * `--jobs <n>`: renders in worker threads. Job k goes to worker k mod n (a fixed split, so which thread drew a picture
 * never depends on timing); each worker opens the meshes once and posts back each render's record. The caller sorts
 * the records by job, so the run's index is the same whatever the threads' speed. Worker messages to the console
 * (progress lines) are passed through as they come.
 */
import { Worker } from "node:worker_threads";
import type { Io, RenderEnv } from "./render3d";
import type { Job, JobOutput } from "./job";

export interface WorkerData {
  argv: string[];
  env: RenderEnv;
  out: string;
  jobs: Job[];
}

export type WorkerMessage =
  | { kind: "log"; text: string }
  | { kind: "done"; output: JobOutput }
  | { kind: "meta"; meta: Meta }
  | { kind: "error"; message: string };

export type Meta = { meshSource: string; note: string; install: string | null; meshStats: unknown };

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
): Promise<{ outputs: JobOutput[]; meta: Meta }> {
  const outputs: JobOutput[] = [];
  const metas: Meta[] = [];
  const url = new URL("./worker.ts", import.meta.url);
  await Promise.all(
    splitJobs(jobs, threads).map(
      (share) =>
        new Promise<void>((resolveRun, reject) => {
          const data: WorkerData = { ...base, jobs: share };
          const w = new Worker(url, { workerData: data, execArgv: process.execArgv });
          w.on("message", (m: WorkerMessage) => {
            if (m.kind === "log") io.err(m.text);
            else if (m.kind === "done") outputs.push(m.output);
            else if (m.kind === "meta") metas.push(m.meta);
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
  return {
    outputs,
    meta: metas[0] ?? { meshSource: "", note: "", install: null, meshStats: null },
  };
}
