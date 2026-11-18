/**
 * Symbol catalogue for the UX §6.2 cartographic vocabulary. Symbol ids are what DisplayItem.symbol.id carries:
 * "feat-<FeatureType>", "door-<OpeningKind>", "link-<LinkKind>". Each entry names the non-colour cue, so a legend
 * (UX §6.3) and tests can check that nothing relies on colour alone. The drawing itself lives in
 * @slabyrinth/render-canvas (symbol painters).
 */
import type { FeatureType, LinkKind, OpeningKind } from "../contracts/plan";
import { FEATURE_TYPES, LINK_KINDS, OPENING_KINDS } from "../contracts/plan";
import { FEATURE_INFO } from "../gen/catalog";

export interface SymbolInfo {
  id: string;
  kind: "feature" | "door" | "link";
  label: string;
  /** Non-colour cue drawn by the painter (UX §6.2 right-hand column). */
  cue: string;
}

const FEATURE_CUE: Partial<Record<FeatureType, string>> = {
  pillar: "filled circle",
  statue: "circle with star",
  table: "rounded rectangle",
  round_table: "circle",
  bench: "rounded rectangle",
  bed: "rectangle with pillow line",
  bunk_bed: "rectangle with two pillow lines",
  chest: "rectangle with lid line",
  altar: "double outline",
  sarcophagus: "coffin hexagon with centre line",
  coffin: "coffin hexagon",
  brazier: "circle with six rays",
  torch_wall: "rays at the wall",
  candelabra: "rays",
  campfire: "rays",
  barrel: "circle with ring",
  crate: "square with X",
  bookshelf: "thin rectangle with ticks",
  shelf: "thin rectangle with ticks",
  weapon_rack: "thin rectangle with ticks",
  bones: "dot cluster",
  debris: "dot cluster",
  rubble: "dots and small polygons",
  trap: "triangle with T",
  trap_plate: "triangle with T",
  tree: "scalloped circle with centre dot",
  pine_tree: "spiky star",
  dead_tree: "bare branches",
  bush: "small scalloped circle",
  rock: "irregular polygon",
  boulder: "irregular polygon",
  custom: "rounded square with ?",
};

export const SYMBOLS: Record<string, SymbolInfo> = (() => {
  const out: Record<string, SymbolInfo> = {};
  for (const t of FEATURE_TYPES) {
    out[`feat-${t}`] = {
      id: `feat-${t}`,
      kind: "feature",
      label: FEATURE_INFO[t].label,
      cue: FEATURE_CUE[t] ?? "outlined shape",
    };
  }
  const doorCue: Record<OpeningKind, [string, string]> = {
    door: ["Door", "leaf across a wall gap"],
    double_door: ["Double door", "two leaves"],
    locked_door: ["Locked door", "leaf with a dot"],
    secret_door: ["Secret door", "dashed wall + S"],
    portcullis: ["Portcullis", "row of dots"],
    archway: ["Archway", "gap with posts"],
    open: ["Opening", "gap"],
    window: ["Window", "slit along the wall"],
    arrow_slit: ["Arrow slit", "short slit"],
    bars: ["Bars", "row of dots"],
  };
  for (const k of OPENING_KINDS)
    out[`door-${k}`] = { id: `door-${k}`, kind: "door", label: doorCue[k][0], cue: doorCue[k][1] };
  const linkCue: Record<LinkKind, [string, string]> = {
    stairs: ["Stairs", "treads + chevron"],
    spiral_stairs: ["Spiral stairs", "radial treads"],
    ladder: ["Ladder", "rails and rungs"],
    ramp: ["Ramp", "chevrons"],
    trapdoor: ["Trapdoor", "square with X"],
    pit_drop: ["Pit", "dark square with X"],
  };
  for (const k of LINK_KINDS)
    out[`link-${k}`] = { id: `link-${k}`, kind: "link", label: linkCue[k][0], cue: linkCue[k][1] };
  return out;
})();

export function symbolInfo(id: string): SymbolInfo | undefined {
  return SYMBOLS[id];
}
