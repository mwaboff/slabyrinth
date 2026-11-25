import { parentPort } from "node:worker_threads";
import { createSceneHandler } from "./sceneHandler";
import { sceneWorkerLoop } from "./sceneLoop";
import type { SceneWorkerMessage, SceneWorkerResponse } from "./sceneProtocol";

/**
 * scene.worker entry (worker_thread): lays out 3D scenes and renders their pictures off the main thread. Jobs run one
 * after another, in order (sceneLoop.ts).
 */
const port = parentPort;
if (port) {
  const onMessage = sceneWorkerLoop(createSceneHandler());
  const post = (r: SceneWorkerResponse): void => {
    port.postMessage(r);
  };
  port.on("message", (msg: SceneWorkerMessage) => {
    onMessage(msg, post);
  });
}
