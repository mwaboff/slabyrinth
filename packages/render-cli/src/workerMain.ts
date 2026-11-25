/**
 * What a render thread of `--jobs` does (batch.ts): opens the meshes once, at the install its parent found and from the
 * cache its parent warmed (it never looks for TaleSpire and never reads a bundle), renders its share of the jobs and
 * posts each back. Never rejects: a failure is posted as an error message.
 */
import { parseArgs } from "./args";
import type { WorkerData, WorkerMessage } from "./batch";
import { compareSpec, openRunner } from "./job";

export async function runWorker(data: WorkerData, post: (m: WorkerMessage) => void): Promise<void> {
  try {
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
    const env = { ...data.env, locate: () => Promise.resolve(data.install) };
    const runner = await openRunner(a, io, env, data.out, compareSpec(a, data.env.cwd, inputs));
    for (const job of data.jobs) post({ kind: "done", output: await runner.run(job) });
  } catch (e) {
    post({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
}
