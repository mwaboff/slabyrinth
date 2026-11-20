/**
 * Tones observed in the owner's screenshots, by asset uuid, for palette rows that do not carry a `tone` tag yet.
 * Never guessed: each entry is a piece someone has seen in game. A palette row's own `tone` wins. (The palette
 * import script regenerates the rows; until it carries `tone`/`hue`, this table keeps the observations.)
 */
export const OBSERVED_TONES: Readonly<
  Record<string, { tone: "dark" | "mid" | "light"; hue?: string; name: string }>
> = {
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
