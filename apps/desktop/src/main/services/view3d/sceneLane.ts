import type { Logger } from "../../logger";
import { DeadlineExceeded, withDeadline } from "../../util/deadline";
import { AppFailure } from "../../util/errors";
import type {
  SceneWorkerMessage,
  SceneWorkerRequest,
  SceneWorkerResponse,
} from "../../workers/sceneProtocol";
import { isOutOfMemory, type WorkerPort } from "../meshes/workerPort";

/**
 * One owner's scene worker (View3dService keeps one lane for the 3D tab and one for the model's pictures). Jobs run in
 * order; each request's deadline counts from when the worker starts it (the worker says "started"), never time spent
 * queued; a request cancelled while queued is skipped without touching the worker. Only a job that already started and
 * must stop (its owner cancelled it, or it ran past its deadline) stops the worker: layout is synchronous core code that
 * cannot be interrupted. That is the last resort and it costs this lane only: every other request in flight here fails
 * with `LANE_RESTARTED` ("not_found": the scene is gone, open it again) and `onDrop` lets the owner forget its scenes.
 */
export const LANE_RESTARTED = "The 3D view was restarted; open it again.";

export type ScenePort = WorkerPort<SceneWorkerMessage, SceneWorkerResponse>;

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

interface Pending {
  started: boolean;
  start: () => void;
  resolve: (r: SceneWorkerResponse) => void;
  reject: (e: Error) => void;
  progress?: (done: number, total: number) => void;
}

/** The scene worker ran out of memory (its `resourceLimits`): the owner may lay the scene out again with boxes. */
export class OutOfMemory extends Error {
  constructor() {
    super("out of memory");
    this.name = "OutOfMemory";
  }
}

export class SceneLane {
  private worker: ScenePort | null = null;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;

  constructor(
    private readonly name: string,
    private readonly spawn: () => ScenePort,
    private readonly logger: Logger,
    /** The worker stopped (or died): every scene it held is gone. */
    private readonly onDrop: () => void,
  ) {}

  /** A worker is running (it holds this lane's scenes). */
  get alive(): boolean {
    return this.worker !== null;
  }

  private ensureWorker(): ScenePort {
    if (this.worker) return this.worker;
    const w = this.spawn();
    this.worker = w;
    w.on("message", (r: SceneWorkerResponse) => {
      if (this.worker !== w) return;
      const p = this.pending.get(r.id);
      if (!p) return;
      if (r.type === "started") {
        p.start();
        return;
      }
      if (r.type === "progress") {
        p.progress?.(r.done, r.total);
        return;
      }
      this.pending.delete(r.id);
      if (r.type === "error")
        p.reject(
          new AppFailure(r.code ?? "internal", r.code ? r.message : `The 3D view failed: ${r.message}`),
        );
      else p.resolve(r);
    });
    // the job running when the worker died gets the cause (an out-of-memory build is laid out again with boxes);
    // the ones queued behind it only lost their scene
    const dead = (err: Error): void => {
      if (this.worker === w) this.drop(err, new AppFailure("not_found", LANE_RESTARTED));
    };
    w.on("error", (err: Error) => {
      this.logger.error("scene worker crashed", { lane: this.name, error: err });
      dead(isOutOfMemory(err) ? new OutOfMemory() : err);
    });
    w.on("exit", (code: number) => {
      dead(isOutOfMemory(code) ? new OutOfMemory() : new Error(`scene worker exit ${String(code)}`));
    });
    return w;
  }

  /**
   * Stops the worker: every scene it held is gone. The oldest request in flight (the job the worker was running: it
   * runs them in order, whether or not its "started" has arrived yet) fails with `err`, the ones behind it with `queued`.
   */
  drop(err: Error, queued: Error = err): void {
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate().catch(() => undefined);
    const all = [...this.pending.values()];
    this.pending.clear();
    if (w) this.onDrop();
    all.forEach((p, i) => {
      p.reject(i === 0 ? err : queued);
    });
  }

  /**
   * Posts a job. `ms` is its running-time deadline; `signal` is its owner's cancel (honoured while queued or running).
   */
  request(
    msg: WithoutId<SceneWorkerRequest>,
    ms: number,
    signal?: AbortSignal,
    progress?: (done: number, total: number) => void,
  ): Promise<SceneWorkerResponse> {
    const id = ++this.seq;
    return new Promise<SceneWorkerResponse>((resolve, reject) => {
      const stopped = new AppFailure("cancelled", "Stopped.");
      if (signal?.aborted) {
        reject(stopped);
        return;
      }
      let running: AbortSignal | null = null;
      const onCancel = (): void => {
        this.abort(id, stopped);
      };
      const onRunAbort = (): void => {
        this.abort(
          id,
          running?.reason instanceof DeadlineExceeded
            ? new AppFailure("internal", "The 3D view didn't answer in time.")
            : stopped,
        );
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onCancel);
        running?.removeEventListener("abort", onRunAbort);
      };
      const p: Pending = {
        started: false,
        start: () => {
          if (p.started) return;
          p.started = true;
          signal?.removeEventListener("abort", onCancel);
          running = withDeadline(signal, ms);
          if (running.aborted) onRunAbort();
          else running.addEventListener("abort", onRunAbort, { once: true });
        },
        resolve: (r) => {
          cleanup();
          resolve(r);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
        ...(progress ? { progress } : {}),
      };
      this.pending.set(id, p);
      signal?.addEventListener("abort", onCancel, { once: true });
      this.ensureWorker().postMessage({ ...msg, id });
    });
  }

  private abort(id: number, err: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (!p.started) {
      // still queued: the worker drops it; nothing else is touched
      this.worker?.postMessage({ type: "skip", id });
      p.reject(err);
      return;
    }
    p.reject(err);
    this.logger.warn("scene worker stopped to end a job", { lane: this.name, reason: err.message });
    this.drop(new AppFailure("not_found", LANE_RESTARTED));
  }
}
