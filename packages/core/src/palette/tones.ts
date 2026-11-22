import { maxOf } from "../util/lists";
/**
 * The one tone scale: a palette variant's `tone`, the observations below, and the floor materials' guess
 * (resolve/materials.ts MATERIAL_INFO `tone`), darkest first.
 */
export type Tone = "dark" | "mid" | "light";

/** A tone's rank on the scale (0 dark, 1 mid, 2 light), for "paler by a step" comparisons. */
export const TONE_RANK: Readonly<Record<Tone, number>> = { dark: 0, mid: 1, light: 2 };

/** Is a tone at an end of the scale (dark or light: a known contrast), not its middle? */
export function isToneExtreme(t: Tone): boolean {
  return TONE_RANK[t] === 0 || TONE_RANK[t] === maxOf(Object.values(TONE_RANK));
}

/**
 * The tone of one palette variant: its own `tone`, else what was observed of its asset (OBSERVED_TONES); undefined
 * when neither is known. The one reading of a piece's tone (the palette view, floor families, the review).
 */
export function variantTone(v: {
  readonly tone?: Tone | undefined;
  readonly uuid: string;
}): Tone | undefined {
  return v.tone ?? OBSERVED_TONES[v.uuid]?.tone;
}

/** Two tones are close when both are known and no more than one step apart, or when either is unknown. */
export function tonesClose(a: Tone | undefined, b: Tone | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return Math.abs(TONE_RANK[a] - TONE_RANK[b]) <= 1;
}

/**
 * Tones observed in the owner's screenshots, by asset uuid, for palette rows that do not carry a `tone` tag yet.
 * Each entry is a piece someone has seen in game (an entry marked `basis: "guess"` is the exception, said so). A palette row's own `tone` wins. (The palette
 * import script regenerates the rows; until it carries `tone`/`hue`, this table keeps the observations.)
 */
export const OBSERVED_TONES: Readonly<
  Record<string, { tone: Tone; hue?: string; name: string; basis?: "guess" }>
> = {
  // cliff rock (owner's glen and terraced-hill screenshots, 2026-11-20): the Cliff Face shelves read cream next to grey
  // Boulder - Large stones. The catalog's own tags say otherwise (Cliff Face "black"), so tags are no evidence here.
  "a79a9a45-3bf2-4775-98c8-559ca5211532": { tone: "light", hue: "cream", name: "Cliff Face" },
  "451e9727-bc73-462c-8c46-512687e6e170": { tone: "mid", hue: "grey", name: "Boulder - Large" },
  // not seen in any screenshot: a guess from the catalog tags (green, brown), kept so the pieces of a boulder role
  // share one family; replace when someone sees the piece in game
  "2e255c74-6c6a-463d-a2a2-d8d97c327bfe": {
    tone: "mid",
    hue: "green-brown",
    name: "Moss Rock 01",
    basis: "guess",
  },
  // cave "dark rock" floor family
  "83b31a56-ea61-4246-82b0-07692527ac76": { tone: "dark", name: "bg_floor_1x1_01" },
  "925500fe-075a-42a0-8b01-eb535e2595a3": { tone: "dark", name: "bg_floor_1x2_01" },
  "0fc0a09b-35fa-4d8f-9397-3639f4404b8a": { tone: "dark", name: "bg_floor_2x2_01" },
  "354701ef-e436-4494-812c-2efd268f057f": { tone: "dark", name: "bg_floor_2x2_02" },
  "f4c70107-0a58-4df6-a0fc-f71864ce54f0": { tone: "dark", name: "bg_floor_2x2_cr_01" },
  // the pale green-grey cave floor
  "ea5589dc-507a-4e0d-bf48-b097c8318a38": { tone: "light", hue: "green-grey", name: "Cave Floor - Rock 03" },
  // peach desert sand
  "3723541f-4c2d-46df-9ed4-5dbafff1146f": { tone: "light", hue: "peach", name: "Desert Ground 01" },
  "4bfbdf17-8c93-48b2-adf8-f2ab39135e0b": { tone: "light", hue: "peach", name: "Desert Ground 01" },
};
