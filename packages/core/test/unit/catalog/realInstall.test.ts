/**
 * Opt-in: parses the real TaleSpire install when present (read-only) and cross-checks against the research
 * extract data/talespire-assets.json when that (gitignored) file exists. Skips otherwise, e.g. in CI.
 * Override the location with SLABYRINTH_TALESPIRE=<install dir>.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CatalogAsset } from "../../../src/contracts/compiler";
import { binaryIndexSource, indexJsonSource, readBinaryIndex } from "../../../src/catalog";

const install =
  process.env["SLABYRINTH_TALESPIRE"] ?? "C:\\Program Files (x86)\\Steam\\steamapps\\common\\TaleSpire";
const tw = join(install, "Taleweaver");
const packs = existsSync(tw)
  ? readdirSync(tw).filter((d) => /^[0-9a-f-]{36}$/i.test(d) && existsSync(join(tw, d, "index")))
  : [];
const extractPath = fileURLToPath(new URL("../../../../../data/talespire-assets.json", import.meta.url));

describe.skipIf(packs.length === 0)("real TaleSpire install (opt-in)", () => {
  const all: CatalogAsset[] = [];
  for (const id of packs) {
    it(`parses ${id}/index with no warnings`, () => {
      const bytes = new Uint8Array(readFileSync(join(tw, id, "index")));
      const raw = readBinaryIndex(bytes);
      expect(raw.warnings).toEqual([]);
      const r = binaryIndexSource.read(bytes, { packId: id, dirName: id });
      expect(r.assets.length).toBeGreaterThan(100);
      all.push(...r.assets);
    });
    it.skipIf(!existsSync(join(tw, id, "index.json")))(`index.json of ${id} agrees on ids and names`, () => {
      const json = indexJsonSource.read(new Uint8Array(readFileSync(join(tw, id, "index.json"))), {
        packId: id,
        dirName: id,
      });
      const bin = binaryIndexSource.read(new Uint8Array(readFileSync(join(tw, id, "index"))), {
        packId: id,
        dirName: id,
      });
      const j = new Map(json.assets.map((a) => [a.uuid, a.name]));
      // The json file can be stale; only compare assets present in both.
      const common = bin.assets.filter((a) => j.has(a.uuid));
      expect(common.length).toBeGreaterThan(bin.assets.length * 0.9);
      for (const a of common) expect(a.name).toBe(j.get(a.uuid));
    });
  }
  it.skipIf(!existsSync(extractPath))("matches data/talespire-assets.json record for record", () => {
    const ref = (JSON.parse(readFileSync(extractPath, "utf8")) as { assets: CatalogAsset[] }).assets;
    const mine = new Map(all.map((a) => [a.uuid, a]));
    let compared = 0;
    for (const r of ref) {
      const m = mine.get(r.uuid);
      if (!m) continue;
      compared++;
      const expected: Partial<CatalogAsset> & { sizeTag?: unknown } = { ...r };
      // PowerShell writes null or {} when there is no size tag; the TS reader omits the field.
      if (typeof expected.sizeTag !== "string") delete expected.sizeTag;
      expect(m).toEqual(expected);
    }
    expect(compared).toBe(ref.length);
  });
});
