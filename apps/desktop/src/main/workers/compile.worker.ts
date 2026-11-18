import { parentPort } from "node:worker_threads";
import { createCompileHandler } from "./compileHandler";
import type { WorkerRequest } from "./protocol";

/** compile.worker entry (worker_thread): runs core's compile off the main thread. */
const port = parentPort;
if (port) {
  const handle = createCompileHandler();
  port.on("message", (msg: WorkerRequest) => {
    handle(msg, (r) => {
      port.postMessage(r);
    });
  });
}
