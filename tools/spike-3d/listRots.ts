/** Research: tallies (piece name, rot) for ship-kit pieces in slab files, with positions. */
import { readFileSync } from "node:fs";
import { decode } from "../../packages/core/src/slab";
import { loadCatalog } from "./pieces";

const cat = loadCatalog();
const re = new RegExp(process.argv[2] ?? "Ship bottom|fence bow", "i");
for (const f of process.argv.slice(3)) {
  const tally = new Map<string, string[]>();
  for (const line of readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim()))
    for (const a of decode(line.trim()).assets) {
      const e = cat.get(a.uuid.toLowerCase());
      if (!e || !re.test(e.name)) continue;
      const k = `${e.name} rot ${a.rot}`;
      const l = tally.get(k) ?? [];
      l.push(`(${a.sx / 100},${a.sy / 100},${a.sz / 100})`);
      tally.set(k, l);
    }
  console.log(`== ${f.split(/[\\/]/).slice(-2).join("/")}`);
  for (const [k, v] of [...tally].sort()) console.log(`  ${k}: ${v.length}× ${v.slice(0, 4).join(" ")}${v.length > 4 ? " …" : ""}`);
}
