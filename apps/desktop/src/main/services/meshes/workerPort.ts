/** A worker_thread as the 3D services use it (tests pass an in-process double). */
export interface WorkerPort<Req, Res> {
  postMessage(msg: Req): void;
  on(event: "message", fn: (msg: Res) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  on(event: "exit", fn: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

/** A worker that hit its `resourceLimits` ends with this error code, or exit code 134. */
export function isOutOfMemory(err: Error | number): boolean {
  if (typeof err === "number") return err === 134;
  return (err as Error & { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY";
}
