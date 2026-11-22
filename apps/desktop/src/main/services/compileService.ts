import type { CompileEstimate, ExportBundle, LevelId } from "@slabyrinth/core";
import type { Logger } from "../logger";
import type { CompileInput } from "../ports/compile";
import { DEADLINES, DeadlineExceeded, withDeadline } from "../util/deadline";
import { AppFailure } from "../util/errors";
import type { WorkerRequest, WorkerResponse } from "../workers/protocol";
import type { EmitEvent } from "./events";

/**
 * CompileService: runs core's compile in a worker_thread (architecture §6.1) with progress
 * (compile:progress) and cancellation (the worker is terminated). One build at a time. Every request has a deadline
 * and may take a signal (util/deadline.ts): when either ends it, the worker is terminated and the request rejects,
 * so a compile that never returns cannot hold a build, a turn or the Stop button.
 */
export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  on(event: "message", fn: (msg: WorkerResponse) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  on(event: "exit", fn: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export interface CompileServiceDeps {
  spawn: () => WorkerLike;
  emit: EmitEvent;
  logger: Logger;
  /** Overrides of DEADLINES (tests). */
  deadlines?: { estimateMs?: number; runMs?: number };
}

/** A worker that hits its `resourceLimits` (app.ts: 4 GB) ends with this error code, or with exit code 134 (abort). */
const OOM_ERROR_CODE = "ERR_WORKER_OUT_OF_MEMORY";
const OOM_EXIT_CODE = 134;
export const OUT_OF_MEMORY =
  "The build ran out of memory. Close other programs and build again, or use a smaller Maximum map size in Settings for new maps.";

const isOutOfMemory = (err: Error): boolean => (err as Error & { code?: unknown }).code === OOM_ERROR_CODE;

interface Running {
  worker: WorkerLike;
  cancel: () => void;
}

export class CompileService {
  private running: Running | null = null;
  private seq = 0;

  constructor(private readonly deps: CompileServiceDeps) {}

  get busy(): boolean {
    return this.running !== null;
  }

  async run(input: CompileInput): Promise<ExportBundle> {
    if (this.running) throw new AppFailure("busy", "A build is already running.");
    const ms = this.deps.deadlines?.runMs ?? DEADLINES.compileRunMs;
    const r = await this.request({ type: "compile", id: 0, input }, true, undefined, ms);
    if (r.type !== "compiled") throw new AppFailure("internal", "Unexpected compiler reply.");
    return r.bundle;
  }

  async estimate(input: CompileInput, levels?: LevelId[], signal?: AbortSignal): Promise<CompileEstimate> {
    const msg: WorkerRequest =
      levels === undefined ? { type: "estimate", id: 0, input } : { type: "estimate", id: 0, input, levels };
    const ms = this.deps.deadlines?.estimateMs ?? DEADLINES.compileEstimateMs;
    const r = await this.request(msg, false, signal, ms);
    if (r.type !== "estimated") throw new AppFailure("internal", "Unexpected compiler reply.");
    return r.estimate;
  }

  cancel(): void {
    this.running?.cancel();
  }

  private request(
    msg: WorkerRequest,
    track: boolean,
    signal: AbortSignal | undefined,
    ms: number,
  ): Promise<WorkerResponse> {
    const id = ++this.seq;
    const worker = this.deps.spawn();
    const deadline = withDeadline(signal, ms);
    return new Promise<WorkerResponse>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (track && this.running?.worker === worker) this.running = null;
        void worker.terminate().catch(() => undefined);
        fn();
      };
      const stop = (): void => {
        finish(() => {
          if (deadline.reason instanceof DeadlineExceeded) {
            this.deps.logger.warn("compile worker timed out", { ms });
            reject(new AppFailure("internal", "The compiler didn't answer in time."));
          } else reject(new AppFailure("cancelled", "Build cancelled."));
        });
      };
      if (deadline.aborted) {
        stop();
        return;
      }
      deadline.addEventListener("abort", stop, { once: true });
      if (track) {
        this.running = {
          worker,
          cancel: () => {
            finish(() => {
              reject(new AppFailure("cancelled", "Build cancelled."));
            });
          },
        };
      }
      worker.on("message", (r: WorkerResponse) => {
        if (r.id !== id) return;
        if (r.type === "progress") {
          if (track) this.deps.emit("compile:progress", { stage: r.stage, done: r.done, total: r.total });
          return;
        }
        if (r.type === "error") {
          this.deps.logger.warn("compile worker error", { message: r.message });
          finish(() => {
            reject(new AppFailure("internal", `The build failed: ${r.message}`));
          });
          return;
        }
        finish(() => {
          resolve(r);
        });
      });
      worker.on("error", (err: Error) => {
        this.deps.logger.error("compile worker crashed", { error: err });
        finish(() => {
          reject(
            isOutOfMemory(err)
              ? new AppFailure("internal", OUT_OF_MEMORY)
              : new AppFailure("internal", "The build stopped unexpectedly."),
          );
        });
      });
      worker.on("exit", (code: number) => {
        finish(() => {
          reject(
            code === OOM_EXIT_CODE
              ? new AppFailure("internal", OUT_OF_MEMORY)
              : new AppFailure("internal", `The build stopped unexpectedly (exit ${String(code)}).`),
          );
        });
      });
      worker.postMessage({ ...msg, id });
    });
  }
}
