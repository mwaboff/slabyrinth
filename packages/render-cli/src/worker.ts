/** A render thread of `--jobs` (batch.ts): opens the meshes once, renders its share of the jobs, posts each back. */
import { parentPort, workerData } from "node:worker_threads";
import { parseArgs } from "./args";
import type { WorkerData, WorkerMessage } from "./batch";
import { compareSpec, openRunner } from "./job";

const data = workerData as WorkerData;
const post = (m: WorkerMessage): void => parentPort?.postMessage(m);

async function main(): Promise<void> {
  const a = parseArgs(data.argv);
  const io = {
    out: (s: string) => {
      post({ kind: "log", text: s });
    },
    err: (s: string) => {
      post({ kind: "log", text: s });
    },
  };
  const inputs = data.jobs.map((j) => j.input);
  const runner = await openRunner(a, io, data.env, data.out, compareSpec(a, data.env.cwd, inputs));
  post({ kind: "meta", meta: runner.meta() });
  for (const job of data.jobs) post({ kind: "done", output: await runner.run(job) });
}

main().catch((e: unknown) => {
  post({ kind: "error", message: e instanceof Error ? e.message : String(e) });
});
