/**
 * Research: re-turns a slab's hull halves, centre strips and curved bow rails by the measured rule
 * (ship-kit-geometry.md) and re-encodes it, to test the rule end to end with hullCheck and a render. Each hull
 * half keeps its position; L halves go to the port slot and R halves to the starboard slot of their pair.
 * Usage: fixHull <in.txt> <out.txt> <frameRot F: 0 north, 6 east, 12 south, 18 west>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decode, encode } from "../../packages/core/src/slab";
import { loadCatalog } from "./pieces";

const [inFile, outFile, fArg] = process.argv.slice(2);
if (!inFile || !outFile || fArg === undefined) throw new Error("usage: fixHull <in> <out> <F>");
const F = Number(fArg);
const cat = loadCatalog();
const idOf = (n: string): string => [...cat.values()].find((e) => e.name === n)!.id;
const ID = {
  L_Bow: idOf("Ship bottom front L_Bow"),
  R_Bow: idOf("Ship bottom front R_Bow"),
  L_Stern: idOf("Ship bottom back L_Stern"),
  R_Stern: idOf("Ship bottom back R_Stern"),
  filler: idOf("Ship bottom front filler 4x2_Bow"),
  fin: idOf("Ship bottom back Fin 4x2_Rudder"),
  curved: idOf("Ship fence bow curved"),
};
// port is to the left looking forward: bow north -> west (-x), east -> north (+z), south -> east, west -> south
const portSign = { 0: [-1, 0], 6: [0, 1], 12: [1, 0], 18: [0, -1] }[F] as [number, number];
const side = (x: number, z: number, cx: number, cz: number): "port" | "stbd" =>
  (x - cx) * portSign[0] + (z - cz) * portSign[1] > 0 ? "port" : "stbd";
const r = (n: number): number => ((n % 24) + 24) % 24;

const lines = readFileSync(inFile, "utf8").split(/\r?\n/).filter((l) => l.trim());
const out: string[] = [];
for (const line of lines) {
  const assets = decode(line.trim()).assets.map((a) => ({ ...a }));
  // pair each bow/stern half with its partner: same position along the ship, adjacent across it
  const halves = assets.filter((a) => [ID.L_Bow, ID.R_Bow, ID.L_Stern, ID.R_Stern].includes(a.uuid.toLowerCase()));
  for (const h of halves) {
    const isBow = h.uuid.toLowerCase() === ID.L_Bow || h.uuid.toLowerCase() === ID.R_Bow;
    const partners = halves.filter(
      (o) =>
        o !== h &&
        ((isBow && (o.uuid.toLowerCase() === ID.L_Bow || o.uuid.toLowerCase() === ID.R_Bow)) ||
          (!isBow && (o.uuid.toLowerCase() === ID.L_Stern || o.uuid.toLowerCase() === ID.R_Stern))) &&
        Math.hypot(o.sx - h.sx, o.sz - h.sz) <= 600,
    );
    const p = partners[0];
    if (!p) continue;
    const s = side(h.sx, h.sz, (h.sx + p.sx) / 2, (h.sz + p.sz) / 2);
    h.uuid = isBow ? (s === "port" ? ID.L_Bow : ID.R_Bow) : s === "port" ? ID.L_Stern : ID.R_Stern;
    h.rot = r(F + 12);
  }
  for (const a of assets) {
    const id = a.uuid.toLowerCase();
    if (id === ID.filler) a.rot = r(F + 12);
    if (id === ID.fin) a.rot = r(F);
    if (id === ID.curved) {
      // which bow half is under this rail: the nearest half at the deck below
      const near = halves
        .filter((h) => h.uuid === ID.L_Bow || h.uuid === ID.R_Bow)
        .sort((x, y) => Math.hypot(x.sx - a.sx, x.sz - a.sz) - Math.hypot(y.sx - a.sx, y.sz - a.sz))[0];
      if (near) a.rot = r(near.uuid === ID.L_Bow ? F + 12 : F + 18);
    }
  }
  out.push(encode(assets).slab);
}
writeFileSync(outFile, out.join("\n"), "utf8");
console.log(`wrote ${outFile}`);
