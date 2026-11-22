/**
 * The quit sequence: the final save first, so no other service can hold it up, then every other step with a time
 * limit, so none can keep the process (and with it the single-instance lock and the project lock) alive. A step that
 * runs past its limit or throws is logged and left behind; the quit goes on.
 */
import type { Logger } from "../logger";

/** How long the final save may take before the project lock is released anyway and the quit goes on. */
export const SAVE_LIMIT_MS = 20_000;
/** How long each other step may take. */
export const STEP_LIMIT_MS = 3_000;

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown> | undefined;
}

export interface ShutdownPlan {
  /** Synchronous stops of running work (a compile, a catalog watch) before the save; they cannot block. */
  halt: Array<() => void>;
  /** The final save and the project lock's release. */
  save: () => Promise<unknown>;
  /** After a save that failed or ran out of time: release the project lock without waiting. */
  releaseLock: () => void;
  /** Everything else, in order. */
  steps: ShutdownStep[];
  logger: Logger;
  saveLimitMs?: number;
  stepLimitMs?: number;
}

/** "done", "timeout", or the error a promise settled with, within `ms` (the timer never keeps the process alive). */
async function within(p: Promise<unknown>, ms: number): Promise<"done" | "timeout" | { error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([p.then(() => "done" as const), limit]);
  } catch (error) {
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

export async function runShutdown(plan: ShutdownPlan): Promise<void> {
  for (const halt of plan.halt)
    try {
      halt();
    } catch (error) {
      plan.logger.warn("shutdown: stopping work failed", { error });
    }
  const save = await within(Promise.resolve().then(plan.save), plan.saveLimitMs ?? SAVE_LIMIT_MS);
  if (save !== "done") {
    if (save === "timeout") plan.logger.error("final save did not finish in time");
    else plan.logger.error("final save failed", { error: save.error });
    plan.releaseLock();
  }
  for (const step of plan.steps) {
    const r = await within(Promise.resolve().then(step.run), plan.stepLimitMs ?? STEP_LIMIT_MS);
    if (r === "timeout") plan.logger.warn("shutdown step did not finish in time", { step: step.name });
    else if (r !== "done") plan.logger.warn("shutdown step failed", { step: step.name, error: r.error });
  }
}
