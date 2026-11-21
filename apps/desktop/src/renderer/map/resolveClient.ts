/**
 * Resolves plans in resolve.worker (falls back to the UI thread where Worker is unavailable) and caches
 * results per (palettes, plan content, version, display options) — architecture §5.4.
 *
 * Plans are resolved against the palettes builds compile with, which main sends as data ("palettes:resolveData");
 * they are fetched once and again whenever main announces a change ("palettes:changed"), and every preview then
 * resolves again, so the 2D view always shows the map the build produces.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { h64hex, type DisplayOptions, type MapPlan } from "@slabyrinth/core";
import type { ResolvePalettesData } from "@slabyrinth/core/palette";
import { call, on } from "../bridge/client";
import type { ResolveWorkerMessage } from "../workers/resolve.worker";
import { compute, palettesFromData, type ResolveRequest, type ResolveResult } from "../../shared/resolveCore";

type Pending = { resolve: (r: ResolveResult) => void; reject: (e: Error) => void };

let worker: Worker | null | undefined;
/** Key of the palettes the worker holds. */
let workerPalettes: string | null = null;
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

// ───────────────────────────── the build's palettes ─────────────────────────────

let palettes: Promise<ResolvePalettesData> | null = null;
let palettesKey: string | null = null;
const keyListeners = new Set<() => void>();
let watching = false;

/** The build's palettes as data: fetched from main once, and again after main says they changed. */
function buildPalettes(): Promise<ResolvePalettesData> {
  if (!watching) {
    watching = true;
    on("palettes:changed", () => {
      palettes = null;
      void buildPalettes().catch(() => undefined);
    });
  }
  palettes ??= call("palettes:resolveData", undefined).then(
    (data) => {
      if (data.key !== palettesKey) {
        palettesKey = data.key;
        for (const l of keyListeners) l();
      }
      return data;
    },
    (e: unknown) => {
      palettes = null;
      throw e;
    },
  );
  return palettes;
}

/** Key of the palettes previews resolve against (null until fetched); a change re-resolves every preview. */
function usePalettesKey(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      keyListeners.add(onChange);
      return () => keyListeners.delete(onChange);
    },
    () => palettesKey,
  );
}

// ───────────────────────────── resolving ─────────────────────────────

const optKey = (o: DisplayOptions): string =>
  [o.grid, o.roomNumbers, o.roomNames, o.furniture, o.gmLayer].map((b) => (b ? 1 : 0)).join("");

/** Content hash per plan object (plans from main are never mutated in the renderer). */
const contentKeys = new WeakMap<MapPlan, string>();
function contentKey(plan: MapPlan): string {
  let k = contentKeys.get(plan);
  if (k === undefined) {
    k = h64hex(JSON.stringify(plan));
    contentKeys.set(plan, k);
  }
  return k;
}

/**
 * The cache key of a resolved preview: the plan's CONTENT (not its id: an imported or duplicated plan keeps its id,
 * and two projects can hold different plans under one id and version), the version it is shown as, and the options.
 */
export function resolveKey(plan: MapPlan, version: number, options: DisplayOptions): string {
  return `${contentKey(plan)}@${version}:${optKey(options)}`;
}

function run(req: ResolveRequest, data: ResolvePalettesData): Promise<ResolveResult> {
  const inThread = (): ResolveResult => compute(req, palettesFromData(data));
  const w = getWorker();
  if (w === null) return Promise.resolve().then(inThread);
  if (workerPalettes !== data.key) {
    w.postMessage({ type: "palettes", data } satisfies ResolveWorkerMessage);
    workerPalettes = data.key;
  }
  return new Promise<ResolveResult>((resolve, reject) => {
    pending.set(req.id, { resolve, reject });
    w.postMessage({ type: "resolve", req } satisfies ResolveWorkerMessage);
  }).catch(inThread);
}

export async function resolveAsync(
  plan: MapPlan,
  version: number,
  options: DisplayOptions,
): Promise<ResolveResult> {
  const data = await buildPalettes();
  const key = `${data.key}|${resolveKey(plan, version, options)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = run({ id: seq++, plan, version, options, palettesKey: data.key }, data);
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
  const palettesNow = usePalettesKey();
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
    // options are captured through `key`; a change of the build's palettes resolves again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, palettesNow]);
  return state;
}
