/**
 * Plain colours by class of piece (design D7). The class is the scene's one classifier (scene/classify.ts: role, layer,
 * material, palette roles, the catalog's and core's own facts), the same the checks read. A small lightness jitter
 * per asset id keeps neighbouring different pieces apart.
 */
import { hashUnitMixed } from "@slabyrinth/core";
import type { ColourClass, Rgb } from "../types/index";
import { pieceClass } from "./classify";

export type { ClassInput, PieceFacts } from "./classify";

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
  plant: { rgb: [52, 120, 58], label: "Plant, tree, rock" },
  tall_prop: { rgb: [44, 104, 124], label: "Tall prop" },
  prop: { rgb: [72, 178, 184], label: "Prop" },
  marker: { rgb: [226, 52, 200], label: "Alignment marker" },
  unknown: { rgb: [214, 64, 64], label: "Unknown piece" },
};

/** The class of a piece: scene/classify.ts `pieceClass` (kept under its first name). */
export const colourClass = pieceClass;

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
