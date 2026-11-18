/**
 * Resolves plans in resolve.worker (falls back to the UI thread where Worker is unavailable) and caches
 * results per (plan id, version, display options) — architecture §5.4.
 */
import { useEffect, useState } from "react";
import type { DisplayOptions, MapPlan } from "@slabyrinth/core";
import { compute, type ResolveRequest, type ResolveResult } from "./resolveCore";

type Pending = { resolve: (r: ResolveResult) => void; reject: (e: Error) => void };

let worker: Worker | null | undefined;
let seq = 1;
const pending = new Map<number, Pending>();
const cache = new Map<string, Promise<ResolveResult>>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") return (worker = null);
  try {
    const w = new Worker(new URL("../workers/resolve.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: ResolveResult; error?: string }>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.ok && ev.data.result) p.resolve(ev.data.result);
      else p.reject(new Error(ev.data.error ?? "resolve failed"));
    };
    w.onerror = () => {
      // Worker failed to load (e.g. CSP): drop to in-thread resolution for the rest of the session.
      for (const [, p] of pending) p.reject(new Error("worker unavailable"));
      pending.clear();
      worker = null;
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

const optKey = (o: DisplayOptions): string =>
  [o.grid, o.roomNumbers, o.roomNames, o.furniture, o.gmLayer].map((b) => (b ? 1 : 0)).join("");

export function resolveKey(plan: MapPlan, version: number, options: DisplayOptions): string {
  return `${plan.id}@${version}:${optKey(options)}`;
}

export function resolveAsync(
  plan: MapPlan,
  version: number,
  options: DisplayOptions,
): Promise<ResolveResult> {
  const key = resolveKey(plan, version, options);
  const hit = cache.get(key);
  if (hit) return hit;
  const req: ResolveRequest = { id: seq++, plan, version, options };
  const w = getWorker();
  const p =
    w === null
      ? Promise.resolve().then(() => compute(req))
      : new Promise<ResolveResult>((resolve, reject) => {
          pending.set(req.id, { resolve, reject });
          w.postMessage(req);
        }).catch(() => compute(req));
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  if (cache.size > 24) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  return p;
}

export interface Resolved extends ResolveResult {
  key: string;
}

/** React hook: the resolved plan for (plan, version, options); keeps the previous result while the next one computes. */
export function useResolved(
  plan: MapPlan | null,
  version: number,
  options: DisplayOptions,
): { data: Resolved | null; error: string | null } {
  const [state, setState] = useState<{ data: Resolved | null; error: string | null }>({
    data: null,
    error: null,
  });
  const key = plan ? resolveKey(plan, version, options) : null;
  useEffect(() => {
    if (!plan || key === null) return;
    let alive = true;
    resolveAsync(plan, version, options).then(
      (r) => {
        if (alive) setState({ data: { ...r, key }, error: null });
      },
      (e: unknown) => {
        if (alive) setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e) }));
      },
    );
    return () => {
      alive = false;
    };
    // options are captured through `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
