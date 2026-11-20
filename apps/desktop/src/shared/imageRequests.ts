/**
 * Answers main's `render:requestImage` (the agent's view_map_image tool, via main's ImageBridge): fetch the plan
 * version main asked for, resolve it, draw the level with the same drawDisplayList routine as the map view and
 * PNG export, and reply with `render:imageResult`.
 *
 * Until 2026-11-19 nothing in the renderer subscribed to `render:requestImage`, so every view_map_image call
 * waited out the bridge's 20 s timeout ("The map image wasn't rendered in time.") and the model never saw its map.
 *
 * Dependencies are injected so main-process tests can drive the real request → reply round trip without a DOM.
 */
import type { DisplayList, DisplayOptions, MapPlan } from "@slabyrinth/core";
import type { IpcEvents, IpcSends } from "./ipc";

export type ImageRequestEvent = IpcEvents["render:requestImage"];
export type ImageResult = IpcSends["render:imageResult"];

export interface ImageRequestDeps {
  /** The plan at a version (main's plan:getVersion). */
  getPlan(version: number): Promise<MapPlan>;
  /** Display lists per level for a plan version. */
  resolve(
    plan: MapPlan,
    version: number,
    options: DisplayOptions,
  ): Promise<{ lists: Record<string, DisplayList> }>;
  /** PNG (base64, no data: prefix) of one display list. */
  render(list: DisplayList, pxPerCell: number): Promise<string>;
  send(result: ImageResult): void;
}

/** What the model sees: the GM view with grid, room numbers, names and furniture. */
export const MODEL_VIEW: DisplayOptions = {
  grid: true,
  roomNumbers: true,
  roomNames: true,
  furniture: true,
  gmLayer: true,
  legend: true,
};

/** Pixels per square so the longer side fits `maxPx` (between 8 and 48). */
export function pxPerCellFor(list: DisplayList, maxPx: number): number {
  const side = Math.max(1, list.viewBox.w + 1, list.viewBox.h + 1);
  return Math.max(8, Math.min(48, Math.floor(maxPx / side)));
}

/** Crops a display list to a cell region (items outside are clipped by the draw routine's viewport). */
export function cropToRegion(list: DisplayList, region: ImageRequestEvent["region"]): DisplayList {
  if (!region) return list;
  const vb = list.viewBox;
  const x = Math.max(vb.x, region.x);
  const y = Math.max(vb.y, region.y);
  const w = Math.max(1, Math.min(vb.x + vb.w, region.x + region.w) - x);
  const h = Math.max(1, Math.min(vb.y + vb.h, region.y + region.h) - y);
  return { ...list, viewBox: { x, y, w, h } };
}

export async function answerImageRequest(req: ImageRequestEvent, deps: ImageRequestDeps): Promise<void> {
  try {
    const plan = await deps.getPlan(req.planVersion);
    const { lists } = await deps.resolve(plan, req.planVersion, MODEL_VIEW);
    const full = lists[req.level];
    if (!full) throw new Error(`no level "${req.level}" in plan v${req.planVersion}`);
    const list = cropToRegion(full, req.region);
    const pngBase64 = await deps.render(list, pxPerCellFor(list, req.maxPx));
    deps.send({ requestId: req.requestId, ok: true, pngBase64 });
  } catch (e) {
    deps.send({ requestId: req.requestId, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
