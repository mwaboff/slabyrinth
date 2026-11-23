/**
 * Research: renders a hull of beam 10 and length 12 (stern 4, two sides of 2, bow 4), bow NORTH, built two ways:
 * A = the seam-test winner (all halves rot 12, filler rot 12, fin rot 0), B = its diagonal mirror (runner-up).
 * Usage: assembly <cacheDir> <outPrefix>
 */
import { writeFileSync } from "node:fs";
import { loadCatalog, PieceLibrary, type PieceGeometry } from "./pieces";
import { encodePng, oblique, render, TOP, type DrawMesh } from "./raster";
import { hashColor, placePositions } from "./scene";

const [cacheDir, prefix] = process.argv.slice(2);
if (!cacheDir || !prefix) throw new Error("usage: assembly <cacheDir> <outPrefix>");
const lib = new PieceLibrary(loadCatalog(), cacheDir);
const byName = (n: string): PieceGeometry => {
  for (const e of lib.catalog.values()) if (e.name === n) return lib.piece(e.id)!;
  throw new Error(n);
};
const P = {
  side: byName("Ship bottom side 4x2_Port and Starboard"),
  L_Bow: byName("Ship bottom front L_Bow"),
  R_Bow: byName("Ship bottom front R_Bow"),
  L_Stern: byName("Ship bottom back L_Stern"),
  R_Stern: byName("Ship bottom back R_Stern"),
  Filler: byName("Ship bottom front filler 4x2_Bow"),
  Fin: byName("Ship bottom back Fin 4x2_Rudder"),
};
type Item = [keyof typeof P, number, number, number];
const common: Item[] = [
  ["side", 6, 0, 4],
  ["side", 6, 0, 6],
  ["side", 18, 6, 4],
  ["side", 18, 6, 6],
  ["Filler", 12, 4, 8],
  ["Fin", 0, 4, 0],
];
const variants: Record<string, Item[]> = {
  A: [...common, ["L_Bow", 12, 0, 8], ["R_Bow", 12, 6, 8], ["L_Stern", 12, 0, 0], ["R_Stern", 12, 6, 0]],
  B: [...common, ["R_Bow", 6, 0, 8], ["L_Bow", 18, 6, 8], ["R_Stern", 18, 0, 0], ["L_Stern", 6, 6, 0]],
};
for (const [v, items] of Object.entries(variants)) {
  const meshes: DrawMesh[] = items.map(([n, rot, x, z]) => ({
    positions: placePositions(P[n], rot, [x, 0, z]),
    indices: P[n].indices,
    color: hashColor(`${n}`),
  }));
  writeFileSync(`${prefix}-${v}-top.png`, encodePng(render(meshes, TOP, { width: 512 })));
  writeFileSync(`${prefix}-${v}-sw35.png`, encodePng(render(meshes, oblique(225, 35), { width: 512 })));
  writeFileSync(`${prefix}-${v}-ne35.png`, encodePng(render(meshes, oblique(45, 35), { width: 512 })));
}
console.log("written");
