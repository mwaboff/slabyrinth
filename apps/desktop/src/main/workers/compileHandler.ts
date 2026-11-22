import { createCoreCompileBackend, type CompileBackend } from "../ports/compile";
import type { WorkerRequest, WorkerResponse } from "./protocol";

/**
 * Worker-side request handler (pure; the worker entry wires it to parentPort, tests call it directly). `backend`: core's
 * compiler; tests may pass a double.
 */
export function createCompileHandler(backend: CompileBackend = createCoreCompileBackend()) {
  return (msg: WorkerRequest, post: (r: WorkerResponse) => void): void => {
    try {
      if (msg.type === "compile") {
        const bundle = backend.compile(msg.input, (stage, done, total) => {
          post({ type: "progress", id: msg.id, stage, done, total });
        });
        post({ type: "compiled", id: msg.id, bundle });
      } else {
        post({ type: "estimated", id: msg.id, estimate: backend.estimate(msg.input, msg.levels) });
      }
    } catch (err) {
      post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  };
}
