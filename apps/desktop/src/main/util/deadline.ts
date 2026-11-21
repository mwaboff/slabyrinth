/**
 * Every outbound wait in main (a provider call, a compile worker request) has a deadline and can be stopped: one
 * mechanism, so nothing can hang a turn or the Stop button. `withDeadline` gives a signal that aborts when the caller's
 * signal does, or after `ms`, whichever comes first; the abort reason says which (`DeadlineExceeded` for the timeout).
 * It uses setTimeout (fake timers in tests drive it) and never keeps the process alive.
 */
export class DeadlineExceeded extends Error {
  constructor(readonly ms: number) {
    super(`No answer within ${String(Math.round(ms / 1000))} s.`);
    this.name = "DeadlineExceeded";
  }
}

export function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const out = new AbortController();
  const timer = setTimeout(() => {
    out.abort(new DeadlineExceeded(ms));
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  const stop = (): void => {
    clearTimeout(timer);
    out.abort(signal?.reason);
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  out.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    },
    { once: true },
  );
  return out.signal;
}

/** How long main waits for each kind of outbound answer. */
export const DEADLINES = {
  /** The model list when a turn starts: past it the provider's bundled table is used (no turn waits on the network). */
  modelListForTurnMs: 8_000,
  /** The model list or a key check asked for by the UI. */
  providerRequestMs: 20_000,
  /** A compile estimate (compile_preview, the build view's estimate). */
  compileEstimateMs: 60_000,
  /** A whole build (the UI can also stop it). */
  compileRunMs: 10 * 60_000,
} as const;
