import { EventEmitter } from "node:events";
import { createCompileHandler } from "../../workers/compileHandler";
import type { WorkerRequest, WorkerResponse } from "../../workers/protocol";
import type { CompileBackend } from "../../ports/compile";
import type { WorkerLike } from "../compileService";
import { fakeCompileBackend } from "./fakeCompileBackend";

/**
 * A WorkerLike that runs the real worker handler in-process (asynchronously), for service tests. `backend`: the
 * compiler it runs (default the fast test double; pass createCoreCompileBackend() for the real one). `delayMs`: how
 * long it waits before answering; `Infinity` never answers (a stuck compile).
 */
export function inProcessWorker(
  backend: CompileBackend = fakeCompileBackend,
  delayMs = 0,
): WorkerLike & { terminated: boolean } {
  const ee = new EventEmitter();
  const handle = createCompileHandler(backend);
  const w = {
    terminated: false,
    postMessage(msg: WorkerRequest) {
      if (delayMs === Infinity) return;
      setTimeout(() => {
        handle(msg, (r: WorkerResponse) => {
          if (!w.terminated) ee.emit("message", r);
        });
      }, delayMs);
    },
    on(event: string, fn: (...args: never[]) => void) {
      ee.on(event, fn as (...args: unknown[]) => void);
      return w;
    },
    terminate() {
      w.terminated = true;
      return Promise.resolve(0);
    },
  };
  return w;
}
