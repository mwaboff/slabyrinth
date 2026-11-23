/** Research: mean vertex colour per cached piece (is it a usable stand-in colour?). Usage: vertexColors <cacheDir> <regex> */
import { join } from "node:path";
import { loadCatalog, PieceLibrary } from "./pieces";

const [cacheDir, pattern] = process.argv.slice(2);
if (!cacheDir || !pattern) throw new Error("usage: vertexColors <cacheDir> <regex>");
const lib = new PieceLibrary(loadCatalog(), join(cacheDir));
const re = new RegExp(pattern, "i");
for (const e of lib.catalog.values()) {
  if (!re.test(e.name)) continue;
  const g = lib.piece(e.id);
  const c = g?.meanColor;
  console.log(`${e.name}: ${c ? c.map((v) => v.toFixed(2)).join(", ") : "no colour channel"}`);
}
