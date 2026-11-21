/**
 * Roof plan of buildings (structures): the roof outline dashed, ridge lines solid, chimneys and porch roofs. A building
 * with volumes draws each set-in storey's wall line and each roof layer's plan; a plain gable draws its wings; any
 * other roof follows the building's area outline.
 */
import type { DisplayItem, ResolvedLevel } from "../../contracts/resolved";
import { gableRoof, hipRoof, ringLayer, shedRoof, spireShell } from "../../resolve/roof";
import { isBareRoof, roofEnds } from "../../resolve/roofTypes";
import { exhaustive } from "../../util/never";
import type { DisplayCtx } from "./context";
import { box, flat } from "./rings";

type Structure = NonNullable<ResolvedLevel["structures"]>[number];
type Volume = NonNullable<Structure["volumes"]>[number];
type Rect = { x: number; y: number; w: number; h: number };

/** Half the arm of the cross marking a spire's finial, in cells. */
const FINIAL_ARM = 0.3;
/** Inset and side of a chimney's square in the roof plan, in cells. */
const CHIMNEY_INSET = 0.2;
const CHIMNEY_SIDE = 0.6;

/** A wall line around a storey's cell rect (walls stand half a cell outside the floor). */
const wallLine = (r: Rect): number[] => box(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);

interface RoofLines {
  rings: number[][];
  ridges: number[][];
}

export function roofItems(c: DisplayCtx): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const st of c.level.structures ?? []) {
    if (st.kind !== "building" || isBareRoof(st.roof.type)) continue;
    const lines: RoofLines = { rings: [], ridges: [] };
    const multi = (st.volumes?.length ?? 0) > 1 || (st.volumes ?? []).some((v) => v.roof.layers.length > 1);
    // a single gable roof is drawn over the building's wings (the roof with gable ends is the one built per wing)
    const perWing = roofEnds(st.roof.type) === "gable";
    if (st.volumes && (multi || !perWing)) for (const v of st.volumes) volumeLines(v, lines);
    else if (perWing && st.wings.length > 0) {
      for (const wg of st.wings) {
        const g = gableRoof(wg);
        lines.rings.push(box(g.outline.x, g.outline.y, g.outline.w, g.outline.h));
        lines.ridges.push([...g.ridge]);
      }
    } else {
      const a = c.level.areas.find((ar) => ar.id === st.id);
      for (const r of a?.outline ?? []) lines.rings.push(flat(r));
    }
    porchAndChimneyLines(st, lines);
    items.push({
      layer: "area_outline",
      style: "roof-outline",
      geom: { rings: lines.rings, closed: true },
      ref: st.id,
    });
    if (lines.ridges.length > 0)
      items.push({
        layer: "area_outline",
        style: "roof-ridge",
        geom: { rings: lines.ridges, closed: false },
        ref: st.id,
      });
  }
  return items;
}

/** A volume: each set-in storey's wall line, then each roof layer's plan (layers step in from the top storey). */
function volumeLines(v: Volume, out: RoofLines): void {
  const { rings, ridges } = out;
  let prev: Rect | null = null;
  for (const s of v.storeys) {
    const r = s.rect;
    if (!prev || r.x !== prev.x || r.y !== prev.y || r.w !== prev.w || r.h !== prev.h)
      rings.push(wallLine(r));
    prev = r;
  }
  const top = v.storeys[v.storeys.length - 1];
  if (!top) return;
  let rect = { ...top.rect };
  // each roof type's plan is its own shape (as in resolve/roof.ts)
  v.roof.layers.forEach((layer, li) => {
    switch (layer.type) {
      case "gable":
        for (const wg of li === 0 ? v.rects : [{ ...rect, ridge: layer.ridge }]) {
          const g = gableRoof(wg);
          rings.push(box(g.outline.x, g.outline.y, g.outline.w, g.outline.h));
          ridges.push([...g.ridge]);
        }
        return;
      case "hip":
      case "shed": {
        const PITCHED = { hip: () => hipRoof(rect), shed: () => shedRoof(rect, layer.low) };
        const g = PITCHED[layer.type]();
        rings.push(box(g.outline.x, g.outline.y, g.outline.w, g.outline.h));
        for (const rg of g.ridges) ridges.push([...rg]);
        return;
      }
      case "skirt":
      case "stepped": {
        const RING = { skirt: "slope", stepped: "step" } as const;
        const g = ringLayer(rect, layer.courses, RING[layer.type], li === 0);
        rings.push(box(g.outline.x, g.outline.y, g.outline.w, g.outline.h));
        if (g.inner) {
          rings.push(box(g.inner.x, g.inner.y, g.inner.w, g.inner.h));
          rect = g.inner;
        }
        return;
      }
      case "spire": {
        const sh = spireShell({ x: rect.x - 0.5, y: rect.y - 0.5, w: rect.w + 1, h: rect.h + 1 });
        for (const k of sh.courses) rings.push(box(k.x0, k.y0, k.x1 - k.x0, k.y1 - k.y0));
        const f = sh.finial;
        ridges.push(
          [f.x - FINIAL_ARM, f.y, f.x + FINIAL_ARM, f.y],
          [f.x, f.y - FINIAL_ARM, f.x, f.y + FINIAL_ARM],
        );
        return;
      }
      case "flat":
        rings.push(wallLine(rect));
        return;
      case "none":
        return;
      default:
        exhaustive(layer.type, "roof type");
    }
  });
}

/** Roofed porches (their cells' bounding box) and chimneys (a small square in their cell). */
function porchAndChimneyLines(st: Structure, out: RoofLines): void {
  for (const p of st.porches) {
    if (!p.roof || p.cells.length === 0) continue;
    const xs = p.cells.map((k) => k[0]);
    const ys = p.cells.map((k) => k[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    out.rings.push(box(x0, y0, Math.max(...xs) - x0 + 1, Math.max(...ys) - y0 + 1));
  }
  for (const ch of st.chimneys)
    out.rings.push(box(ch.at[0] + CHIMNEY_INSET, ch.at[1] + CHIMNEY_INSET, CHIMNEY_SIDE, CHIMNEY_SIDE));
}
