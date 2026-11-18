/** Home thumbnails for the fake bridge (main caches a small PNG of L1; here the renderer draws one). */
import type { MapPlan } from "@slabyrinth/core";
import { compute } from "../../map/resolveCore";
import { drawLevel, mapThemeFor } from "../../map/render";

const cache = new Map<string, string>();

export function thumbnail(plan: MapPlan, key: string): Promise<string | undefined> {
  return Promise.resolve(thumbnailSync(plan, key));
}

function thumbnailSync(plan: MapPlan, key: string): string | undefined {
  const theme = document.documentElement.dataset["theme"] === "light" ? "light" : "dark";
  const k = `${key}:${theme}`;
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  if (
    typeof document === "undefined" ||
    typeof HTMLCanvasElement === "undefined" ||
    /jsdom/i.test(navigator.userAgent)
  )
    return undefined;
  try {
    const r = compute({
      id: 0,
      plan,
      version: 0,
      options: {
        grid: true,
        roomNumbers: true,
        roomNames: false,
        furniture: true,
        gmLayer: true,
        legend: false,
      },
    });
    const entry = plan.entryLevel ?? r.resolved.levels[0]?.id ?? "";
    const list = r.lists[entry] ?? Object.values(r.lists)[0];
    if (!list) return undefined;
    const W = 480;
    const H = 360;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    if (!ctx) return undefined;
    const vb = list.viewBox;
    const scale = Math.min(W / vb.w, H / vb.h) * 0.94;
    drawLevel(ctx, list, mapThemeFor(theme), {
      scale,
      ox: (W - vb.w * scale) / 2 - vb.x * scale,
      oy: (H - vb.h * scale) / 2 - vb.y * scale,
      w: W,
      h: H,
    });
    const png = cv.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
    cache.set(k, png);
    return png;
  } catch {
    return undefined;
  }
}
