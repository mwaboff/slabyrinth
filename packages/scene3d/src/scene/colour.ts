/**
 * Plain colours by class of piece (design D7): the class comes from general rules over the placement's role and paste
 * layer, the material of the cell it came from, and the catalog's own facts (kind, group tag, tags, size), never
 * from a table of pieces. A piece nobody classified still gets a class. A small lightness jitter per asset id keeps
 * neighbouring different pieces apart.
 */
import { hashUnitMixed, materialInfo, type Material, type PlacementRole } from "@slabyrinth/core";
import type { ColourClass, Rgb } from "../types/index";

/** Every class, in legend order, with its colour and its plain name. */
export const COLOUR_CLASSES: Readonly<Record<ColourClass, { rgb: Rgb; label: string }>> = {
  floor: { rgb: [150, 148, 146], label: "Floor" },
  terrain: { rgb: [138, 106, 74], label: "Natural ground" },
  water: { rgb: [62, 122, 204], label: "Water" },
  wall: { rgb: [196, 182, 160], label: "Wall" },
  opening: { rgb: [232, 162, 44], label: "Door, window, gate" },
  stairs: { rgb: [132, 206, 92], label: "Stairs, ladder" },
  roof: { rgb: [182, 84, 58], label: "Roof" },
  light: { rgb: [250, 226, 84], label: "Light" },
  plant: { rgb: [52, 120, 58], label: "Plant, tree" },
  tall_prop: { rgb: [44, 104, 124], label: "Tall prop" },
  prop: { rgb: [72, 178, 184], label: "Prop" },
  marker: { rgb: [226, 52, 200], label: "Alignment marker" },
  unknown: { rgb: [214, 64, 64], label: "Unknown piece" },
};

/** What the catalog (or a palette) says about a piece: the facts the rules read. */
export interface PieceFacts {
  kind: "tile" | "prop" | null;
  groupTag: string;
  tags: readonly string[];
  /** The asset's display name (read last, after the group tag and the tags). */
  name: string;
  /** Height in tiles. */
  height: number;
}

/** Words of a group tag or tag that say what a piece is: one table per class, read by the rules below. */
const WORDS: ReadonlyArray<readonly [ColourClass, RegExp]> = [
  ["roof", /\broofs?\b/],
  ["stairs", /\b(stairs?|steps|ladders?|ramps?)\b/],
  ["opening", /\b(doors?|doorways?|gates?|windows?|hatch(es)?|portcullis|arch(way)?)\b/],
  ["wall", /\b(walls?|corners?|pillars?|columns?|fences?|palisades?|railings?)\b/],
  ["water", /\bwater\b/],
  [
    "light",
    /\b(torch(es)?|lamps?|lanterns?|candles?|candelabras?|chandeliers?|braziers?|sconces?|campfires?|fires?)\b/,
  ],
  [
    "plant",
    /\b(trees?|plants?|bush(es)?|shrubs?|flowers?|ferns?|grass|hedges?|vines?|mushrooms?|reeds?|foliage)\b/,
  ],
  ["floor", /\b(floors?|tiles?|ground|platforms?|decks?)\b/],
];

/** The first class whose words the piece's group tag (first) or tags name, among `allowed`. */
function namedClass(facts: PieceFacts, allowed: ReadonlySet<ColourClass>): ColourClass | null {
  const texts = [facts.groupTag, ...facts.tags, facts.name].map((t) => t.toLowerCase());
  for (const text of texts) for (const [cls, re] of WORDS) if (allowed.has(cls) && re.test(text)) return cls;
  return null;
}

const PROP_NAMED: ReadonlySet<ColourClass> = new Set(["light", "plant", "stairs", "opening"]);
const TILE_NAMED: ReadonlySet<ColourClass> = new Set(["roof", "stairs", "opening", "wall", "water", "floor"]);

function propClass(facts: PieceFacts | null): ColourClass {
  if (!facts) return "prop";
  const named = namedClass(facts, PROP_NAMED);
  if (named) return named;
  return facts.height >= 2 ? "tall_prop" : "prop";
}

export interface ClassInput {
  /** The placement's role; null for a piece read from a slab. */
  role: PlacementRole | null;
  /** Paste layer ("site", "storey:<n>", "roof"). */
  layer: string;
  /** Material of the plan cell the piece came from. */
  material: Material | null;
  facts: PieceFacts | null;
}

/** The colour class of a piece (design §2.3; first rule that matches wins). */
export function colourClass(p: ClassInput): ColourClass {
  if (p.role === "marker") return "marker";
  if (p.layer === "roof") return "roof";
  if (p.material !== null && materialInfo(p.material).water) return "water";
  switch (p.role) {
    case "wall":
    case "wall_post":
      return "wall";
    case "opening":
      return "opening";
    case "link":
      return "stairs";
    case "floor":
    case "fill":
    case "ledge":
      return p.material !== null && materialInfo(p.material).natural ? "terrain" : "floor";
    case "feature":
      return p.facts?.kind === "tile" ? (namedClass(p.facts, TILE_NAMED) ?? "floor") : propClass(p.facts);
    case null:
      break;
  }
  // a bare slab: the catalog's facts alone
  if (!p.facts || p.facts.kind === null) return p.facts ? propClass(p.facts) : "unknown";
  if (p.facts.kind === "tile") return namedClass(p.facts, TILE_NAMED) ?? "floor";
  return propClass(p.facts);
}

/** The colour of a piece of class `cls`, lightened or darkened up to 8% by its asset id. */
export function pieceColour(cls: ColourClass, uuid: string): Rgb {
  const base = COLOUR_CLASSES[cls].rgb;
  const k = 0.92 + 0.16 * hashUnitMixed("scene3d-colour", uuid);
  return [
    Math.min(255, Math.round(base[0] * k)),
    Math.min(255, Math.round(base[1] * k)),
    Math.min(255, Math.round(base[2] * k)),
  ];
}
