/** Research peek: prints index.json records whose names match a pattern (READ-ONLY on the install). */
import { readFileSync } from "node:fs";
const [file, pattern] = process.argv.slice(2);
if (!file || !pattern) throw new Error("usage: peekIndexJson <index.json> <regex>");
const text = readFileSync(file, "utf8").replace(/^﻿/, "");
const j = JSON.parse(text) as Record<string, unknown[]>;
const re = new RegExp(pattern, "i");
const all = [...(j.Tiles ?? []), ...(j.Props ?? [])] as Array<Record<string, unknown>>;
for (const a of all) {
  if (re.test(String(a.Name)))
    console.log(
      JSON.stringify({
        Id: a.Id,
        Name: a.Name,
        Folder: a.Folder,
        Assets: a.Assets,
        C: a.ColliderBoundsBound,
        Icon: a.Icon,
      }),
    );
}
console.log("keys", Object.keys(j));
console.log("atlas0", JSON.stringify((j.IconsAtlases ?? [])[0]).slice(0, 400));
