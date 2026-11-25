import type { SceneWorkerMessage, SceneWorkerRequest, SceneWorkerResponse } from "./sceneProtocol";

/**
 * scene.worker's queue (pure of worker plumbing, so tests run the same queue in-process): jobs run one after another in
 * the order posted; each says "started" before it runs, so main's deadline counts running time only; a "skip" drops a
 * queued job at once (it is handled ahead of the queue).
 */
export function sceneWorkerLoop(
  handle: (msg: SceneWorkerRequest, post: (r: SceneWorkerResponse) => void) => Promise<void> | void,
): (msg: SceneWorkerMessage, post: (r: SceneWorkerResponse) => void) => void {
  const skipped = new Set<number>();
  let queue: Promise<void> = Promise.resolve();
  return (msg, post) => {
    if (msg.type === "skip") {
      skipped.add(msg.id);
      return;
    }
    queue = queue
      .then(async () => {
        // ids grow: a skip for a job already run (it crossed "started" on the way) is forgotten here
        for (const id of skipped) if (id < msg.id) skipped.delete(id);
        if (skipped.delete(msg.id)) return;
        post({ type: "started", id: msg.id });
        await handle(msg, post);
      })
      .catch((err: unknown) => {
        post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
      });
  };
}
