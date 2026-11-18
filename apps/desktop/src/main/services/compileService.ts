import type { CompileEstimate, ExportBundle, LevelId } from "@slabyrinth/core";
import type { Logger } from "../logger";
import type { CompileInput } from "../ports/compile";
import { AppFailure } from "../util/errors";
import type { WorkerRequest, WorkerResponse } from "../workers/protocol";
import type { EmitEvent } from "./events";

/**
 * CompileService: runs core's compile in a worker_thread (architecture §6.1) with progress
 * (compile:progress) and cancellation (the worker is terminated). One build at a time.
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
  /** "none": no compiler in this build (packaged app before WP3 lands). */
  backend: "core" | "fake" | "none";
  emit: EmitEvent;
  logger: Logger;
}

interface Running {
  worker: WorkerLike;
  cancel: () => void;
}

export class CompileService {
  private running: Running | null = null;
  private seq = 0;

  constructor(private readonly deps: CompileServiceDeps) {}

  get backend(): "core" | "fake" | "none" {
    return this.deps.backend;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  async run(input: CompileInput): Promise<ExportBundle> {
    if (this.running) throw new AppFailure("busy", "A build is already running.");
    const r = await this.request({ type: "compile", id: 0, backend: this.backendKind(), input }, true);
    if (r.type !== "compiled") throw new AppFailure("internal", "Unexpected compiler reply.");
    return r.bundle;
  }

  async estimate(input: CompileInput, levels?: LevelId[]): Promise<CompileEstimate> {
    const msg: WorkerRequest =
      levels === undefined
        ? { type: "estimate", id: 0, backend: this.backendKind(), input }
        : { type: "estimate", id: 0, backend: this.backendKind(), input, levels };
    const r = await this.request(msg, false);
    if (r.type !== "estimated") throw new AppFailure("internal", "Unexpected compiler reply.");
    return r.estimate;
  }

  cancel(): void {
    this.running?.cancel();
  }

  private backendKind(): "core" | "fake" {
    if (this.deps.backend === "none")
      throw new AppFailure("unsupported", "The map compiler isn't available in this build yet.");
    return this.deps.backend;
  }

  private request(msg: WorkerRequest, track: boolean): Promise<WorkerResponse> {
    const id = ++this.seq;
    const worker = this.deps.spawn();
    return new Promise<WorkerResponse>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (track && this.running?.worker === worker) this.running = null;
        void worker.terminate().catch(() => undefined);
        fn();
      };
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
            reject(
              new AppFailure(
                r.unsupported === true ? "unsupported" : "internal",
                r.unsupported === true ? r.message : `The build failed: ${r.message}`,
              ),
            );
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
          reject(new AppFailure("internal", "The build stopped unexpectedly."));
        });
      });
      worker.on("exit", (code: number) => {
        finish(() => {
          reject(new AppFailure("internal", `The build stopped unexpectedly (exit ${String(code)}).`));
        });
      });
      worker.postMessage({ ...msg, id });
    });
  }
}
