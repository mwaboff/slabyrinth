import { parentPort } from "node:worker_threads";
import { createMeshHandler } from "./meshHandler";
import type { MeshWorkerRequest } from "./meshProtocol";

/** mesh.worker entry (worker_thread): reads TaleSpire pieces' shapes into the app's cache off the main thread. */
const port = parentPort;
if (port) {
  const handle = createMeshHandler();
  port.on("message", (msg: MeshWorkerRequest) => {
    void handle(msg, (r) => {
      port.postMessage(r);
    });
  });
}
