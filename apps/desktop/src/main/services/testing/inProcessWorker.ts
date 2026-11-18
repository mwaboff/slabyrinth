import { EventEmitter } from "node:events";
import { createCompileHandler } from "../../workers/compileHandler";
import type { WorkerRequest, WorkerResponse } from "../../workers/protocol";
import type { CompileBackend } from "../../ports/compile";
import type { WorkerLike } from "../compileService";

/** A WorkerLike that runs the real worker handler in-process (asynchronously), for service tests. */
export function inProcessWorker(
  coreBackend: CompileBackend | null = null,
  delayMs = 0,
): WorkerLike & { terminated: boolean } {
  const ee = new EventEmitter();
  const handle = createCompileHandler(coreBackend);
  const w = {
    terminated: false,
    postMessage(msg: WorkerRequest) {
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
