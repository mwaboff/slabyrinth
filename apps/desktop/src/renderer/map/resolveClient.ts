/**
 * Resolves plans in resolve.worker (falls back to the UI thread where Worker is unavailable) and caches the results
 * per (palettes, size tier, plan content, version), bounded by the cells they hold — architecture §5.4. Display options
 * are not part of a resolve: toggling one builds new display lists from the cached resolve.
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
import {
  compute,
  displayLists,
  palettesFromData,
  type ResolveRequest,
  type ResolveResult,
} from "../../shared/resolveCore";
import { activeSizeTier } from "../../shared/sizeTier";
import { useSettings } from "../stores/settings";

type Pending = { resolve: (r: ResolveResult) => void; reject: (e: Error) => void };

let worker: Worker | null | undefined;
/** Key of the palettes the worker holds. */
let workerPalettes: string | null = null;
let seq = 1;
const pending = new Map<number, Pending>();

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
      // a prefetch: the next map draw asks again and shows its own failure; this one is only logged
      void buildPalettes().catch((e: unknown) => {
        console.warn("[slabyrinth] could not prefetch the changed palettes", e);
      });
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
 * and two projects can hold different plans under one id and version) and the version it is shown as. The display
 * options are not in it: they only change the display lists, which are built from the one resolve.
 */
export function resolveKey(plan: MapPlan, version: number): string {
  return `${contentKey(plan)}@${version}`;
}

/**
 * The preview cache is bounded by the cells it holds, not by its entries: one resolved 1024² map and its display list
 * keep about 140 MB, so 24 of them would fill the renderer's 4 GB heap. 4 M cells is about four 1024² maps, and still
 * the 24 entry cap for small ones.
 */
export const PREVIEW_CACHE_CELLS = 4_000_000;
const PREVIEW_CACHE_ENTRIES = 24;
/** Display lists kept per resolve (the options shown now and the last ones, for a toggle back). */
const LISTS_PER_ENTRY = 2;

type Base = Omit<ResolveResult, "lists">;
interface Entry {
  base: Promise<Base>;
  /** Display lists per options key, most recent last. */
  lists: Map<string, Promise<ResolveResult["lists"]>>;
  cells: number;
}
const cache = new Map<string, Entry>();

/** Cells of every level together (the plan's bounds). */
export function planCells(plan: Pick<MapPlan, "levels">): number {
  return Math.max(
    1,
    plan.levels.reduce((s, l) => s + l.bounds.w * l.bounds.h, 0),
  );
}

/** What the preview cache holds now (tests). */
export function previewCacheSize(): { entries: number; cells: number } {
  let cells = 0;
  for (const e of cache.values()) cells += e.cells;
  return { entries: cache.size, cells };
}

/** Forgets every cached preview (tests). */
export function clearPreviewCache(): void {
  cache.clear();
}

/** Drops the oldest entries until the cache is within its cell and entry budgets; `keep` stays. */
function trim(keep: string): void {
  let { cells } = previewCacheSize();
  for (const [key, e] of cache) {
    if (cells <= PREVIEW_CACHE_CELLS && cache.size <= PREVIEW_CACHE_ENTRIES) break;
    if (key === keep) continue;
    cache.delete(key);
    cells -= e.cells;
  }
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

/**
 * The resolved plan and its display lists for these options. The plan is resolved (and checked) once per (palettes,
 * size tier, plan content, version); another set of display options only builds new display lists from that resolve.
 */
export async function resolveAsync(
  plan: MapPlan,
  version: number,
  options: DisplayOptions,
): Promise<ResolveResult> {
  const data = await buildPalettes();
  // the plan check holds the plan to the map size setting (raised to what the plan needs: it opens either way)
  const sizeTier = activeSizeTier(useSettings.getState().settings?.mapSize, plan);
  const key = `${data.key}|${sizeTier}|${resolveKey(plan, version)}`;
  const ok = optKey(options);
  let entry = cache.get(key);
  if (entry) {
    // most recently used last
    cache.delete(key);
    cache.set(key, entry);
  } else {
    const p = run({ id: seq++, plan, version, options, palettesKey: data.key, sizeTier }, data);
    entry = {
      base: p.then((r): Base => ({ resolved: r.resolved, labels: r.labels, issues: r.issues })),
      lists: new Map([[ok, p.then((r) => r.lists)]]),
      cells: planCells(plan),
    };
    cache.set(key, entry);
    p.catch(() => cache.delete(key));
    trim(key);
  }
  let lists = entry.lists.get(ok);
  if (lists) entry.lists.delete(ok);
  else lists = entry.base.then((b) => displayLists(b.resolved, b.labels, options));
  entry.lists.set(ok, lists);
  while (entry.lists.size > LISTS_PER_ENTRY) {
    const oldest = entry.lists.keys().next().value;
    if (oldest === undefined) break;
    entry.lists.delete(oldest);
  }
  const [base, l] = await Promise.all([entry.base, lists]);
  return { ...base, lists: l };
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
  const mapSize = useSettings((s) => s.settings?.mapSize);
  const key = plan ? `${resolveKey(plan, version)}:${optKey(options)}` : null;
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
    // options are captured through `key`; a change of the build's palettes or the map size setting resolves again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, palettesNow, mapSize]);
  return state;
}
