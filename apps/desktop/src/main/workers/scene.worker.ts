import { parentPort } from "node:worker_threads";
import { createSceneHandler } from "./sceneHandler";
import type { SceneWorkerRequest } from "./sceneProtocol";

/**
 * scene.worker entry (worker_thread): lays out 3D scenes and renders their pictures off the main thread. Requests run
 * one after another, in order.
 */
const port = parentPort;
if (port) {
  const handle = createSceneHandler();
  let queue = Promise.resolve();
  port.on("message", (msg: SceneWorkerRequest) => {
    queue = queue.then(() =>
      handle(msg, (r) => {
        port.postMessage(r);
      }),
    );
  });
}
