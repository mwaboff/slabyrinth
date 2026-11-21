/**
 * resolve.worker (architecture §6.1): core resolvePlan + buildDisplayList per (plan, version, options),
 * off the UI thread. The same compute() runs in-thread where Worker is unavailable (jsdom tests).
 * The build's palettes arrive once per change ({ type: "palettes" }); each request names the ones it expects.
 */
import type { ResolvePalettes, ResolvePalettesData } from "@slabyrinth/core/palette";
import { compute, palettesFromData, type ResolveRequest } from "../../shared/resolveCore";

export type ResolveWorkerMessage =
  { type: "palettes"; data: ResolvePalettesData } | { type: "resolve"; req: ResolveRequest };

let current: { key: string; palettes: ResolvePalettes } | null = null;

self.onmessage = (ev: MessageEvent<ResolveWorkerMessage>) => {
  const msg = ev.data;
  if (msg.type === "palettes") {
    current = { key: msg.data.key, palettes: palettesFromData(msg.data) };
    return;
  }
  const req = msg.req;
  try {
    if (current?.key !== req.palettesKey) throw new Error("the build's palettes have not reached the worker");
    const result = compute(req, current.palettes);
    self.postMessage({ id: req.id, ok: true, result });
  } catch (e) {
    self.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
