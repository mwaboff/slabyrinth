/**
 * Legend entries (UX §6.3): only what the given display list actually uses, in a stable order. The UI draws each
 * swatch with the real renderer (render-canvas `drawLegendSwatch`).
 */
import type { DisplayList } from "../contracts/resolved";
import { SYMBOLS } from "./symbols";

export interface LegendEntry {
  /** "style" = an area/line style token (rock, water…), "symbol" = a symbol id. */
  kind: "style" | "symbol";
  id: string;
  label: string;
}

const STYLE_LABELS: Array<[string, string]> = [
  // the hatched solid ground around rooms (CELL.SOLID) — not the "Rock" feature (a loose stone on the floor)
  ["rock", "Solid rock"],
  ["chasm", "Chasm / no floor"],
  ["wall", "Wall"],
  ["water-shallow", "Shallow water"],
  ["water-deep", "Deep water"],
  ["ledge", "Ledge (height change)"],
  ["cliff", "Cliff (drop of 1+ tiles)"],
  ["bridge", "Bridge"],
  ["height-up", "Raised floor"],
  ["height-down", "Sunken floor"],
  ["zone-outline", "Zone"],
];

export function legendEntries(list: DisplayList): LegendEntry[] {
  const styles = new Set<string>();
  const symbols = new Set<string>();
  for (const it of list.items) {
    if (it.symbol) symbols.add(it.symbol.id);
    else if (it.geom) {
      let s = it.style;
      if (s.startsWith("height-up")) s = "height-up";
      else if (s.startsWith("height-down")) s = "height-down";
      else if (s.startsWith("wall")) s = "wall";
      else if (s.startsWith("bridge")) s = "bridge";
      styles.add(s);
    }
  }
  const out: LegendEntry[] = [];
  for (const [id, label] of STYLE_LABELS) if (styles.has(id)) out.push({ kind: "style", id, label });
  const order = ["door", "link", "feature"] as const;
  for (const kind of order) {
    const ids = [...symbols].filter((s) => SYMBOLS[s]?.kind === kind).sort();
    for (const id of ids) {
      if (id === "door-open") continue;
      out.push({ kind: "symbol", id, label: SYMBOLS[id]?.label ?? id });
    }
  }
  return out;
}
