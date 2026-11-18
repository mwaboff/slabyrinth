/**
 * The in-game calibration probe (tools/research/Make-CalibrationSlab.ps1, data/calibration-slab.txt), regenerated
 * from the bundled palettes: four 5×5 dungeon pads, one per rot 0/6/12/18, spaced 6 tiles along +x. Each pad has a
 * pillar on its low-x/low-z cell, i+1 pillars in the far corner, a wall in cell (1,3), a door in (3,3) and stairs
 * in (2,1) stored at the cell's min corner with the pad rotation, and a chest prop at the exact centre of (2,2).
 */
import type { PaletteCatalog, SlabAsset } from "../contracts/compiler";
import { resolveRole } from "../palette/resolve";
import { toScaled } from "../slab/codec";

export interface CalibrationAssets {
  floor: string;
  pillar: string;
  wall: string;
  door: string;
  stairs: string;
  chest: string;
}

/** The six assets the probe uses, by name, from the palettes (stone_dungeon roles + generic chest). */
export function calibrationAssetsFrom(cat: PaletteCatalog): CalibrationAssets {
  const byName = (theme: string, role: string, name: string): string => {
    const r = resolveRole(cat, theme, role).resolution;
    const v = r?.variants.find((x) => x.name === name);
    if (!v) throw new Error(`calibration needs "${name}" in palette role ${role} (${theme})`);
    return v.uuid;
  };
  return {
    floor: byName("stone_dungeon", "floor.flagstone", "Dungeon Floor - Small"),
    pillar: byName("stone_dungeon", "feature.pillar", "Dungeon Pillar"),
    wall: byName("stone_dungeon", "wall.wall", "Dungeon Wall 01"),
    door: byName("stone_dungeon", "opening.door", "Door - Dungeon"),
    stairs: byName("stone_dungeon", "link.stairs", "Dungeon Stairs"),
    chest: byName("generic", "feature.chest", "Leather Chest"),
  };
}

export function calibrationSlabAssets(a: CalibrationAssets): SlabAsset[] {
  const out: SlabAsset[] = [];
  const add = (uuid: string, x: number, y: number, z: number, rot: number): void => {
    out.push({ uuid, sx: toScaled(x), sy: toScaled(y), sz: toScaled(z), rot });
  };
  const rots = [0, 6, 12, 18];
  for (let i = 0; i < 4; i++) {
    const ox = i * 6;
    const r = rots[i] ?? 0;
    for (let cx = 0; cx < 5; cx++) for (let cz = 0; cz < 5; cz++) add(a.floor, ox + cx, 0, cz, 0);
    add(a.pillar, ox, 0.5, 0, 0);
    for (let k = 0; k <= i; k++) add(a.pillar, ox + 4, 0.5, 4 - k, 0);
    add(a.wall, ox + 1, 0.5, 3, r);
    add(a.door, ox + 3, 0.5, 3, r);
    add(a.stairs, ox + 2, 0.5, 1, r);
    add(a.chest, ox + 2.5, 0.5, 2.5, r);
  }
  return out;
}
