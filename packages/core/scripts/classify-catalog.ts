/**
 * The developer's auto-palette batch (owner, 2026-11-23: new game assets go into the palettes automatically when it makes
 * sense). Run by an engineer after a TaleSpire update, on a machine with the game's catalog extracted:
 *
 *   npx tsx packages/core/scripts/classify-catalog.ts [--catalog <file>] [--init-seen]
 *
 * It reads the catalog (data/talespire-assets.json by default, or the app's cached catalog: anything with `assets`),
 * leaves out every piece the seen list holds (the pieces already reviewed when the palettes were last curated) and the
 * rejected list, and classifies the rest with the shared classifier (src/palette/autoRoles.ts) against the bundled
 * palettes. Then it
 *   - appends the SURE pieces, every policy family but markers, to packages/core/scripts/palette-auto-assets.json (the
 *     palette import reads it: each piece joins its role after the curated ones, with `minGenerator` = the open
 *     generator, so released generators never see it);
 *   - writes data/catalog-review/report.json: the unsure pieces (with the keyword rules' guess) and new kits, for the
 *     engineer to add by hand or reject;
 *   - refreshes the seen list to every piece of this catalog.
 * Review the batch's diff, run the import, and make a proof slab of the new pieces before committing.
 *
 * The seen and rejected lists and the report live in data/catalog-review/ and are never committed (owner: no bulk list
 * of catalog ids in the repository). The first run on a machine needs `--init-seen`, which records the catalog as it is
 * as already reviewed and adds nothing: pieces the curator left out on purpose are never proposed.
 *
 * Rejecting a piece: add `{ "uuid": "...", "reason": "..." }` to data/catalog-review/rejected.json `entries` (a piece a
 * user excluded in the app and reported, for example) and remove it from palette-auto-assets.json.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogAsset, PaletteVariant } from "../src/contracts/compiler";
import { GENERATOR_VERSION } from "../src/contracts/plan";
import { bundledPalettes } from "../src/palette/load";
import { classifyNew } from "../src/palette/autoRoles";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const reviewDir = join(repo, "data", "catalog-review");
const seenPath = join(reviewDir, "seen.json");
const rejectedPath = join(reviewDir, "rejected.json");
const reportPath = join(reviewDir, "report.json");
const batchPath = join(here, "palette-auto-assets.json");

/** One piece of the batch, in the shape of the import's curated lists (ExtraEntry) and what made it. */
export interface AutoEntry {
  theme: string;
  to: string;
  uuid: string;
  name: string;
  kind: "tile" | "prop";
  size: { x: number; y: number; z: number };
  originAt: "minCorner" | "center" | "other";
  boundsCenter: { x: number; y: number; z: number };
  lengthAxis: "x" | "z" | "square";
  footprintCells: { x: number; z: number };
  variant?: string;
  weight?: number;
  rot?: number;
  offset?: PaletteVariant["offset"];
  facing?: PaletteVariant["facing"];
  stack?: PaletteVariant["stack"];
  minGenerator: number;
  confidence: "sure";
  basis: "sibling";
  /** The palette piece it was modelled on. */
  sibling: string;
  batch: string;
}

interface Batch {
  description: string;
  entries: AutoEntry[];
}

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const catalogPath = resolve(arg("--catalog") ?? join(repo, "data", "talespire-assets.json"));
const raw = readFileSync(catalogPath, "utf8");
const assets = (JSON.parse(raw) as { assets?: CatalogAsset[] }).assets;
if (!Array.isArray(assets)) throw new Error(`${catalogPath} has no "assets" list`);
const sha = createHash("sha256").update(raw).digest("hex").slice(0, 16);
const today = new Date().toISOString().slice(0, 10);
mkdirSync(reviewDir, { recursive: true });

const writeSeen = (): void =>
  writeFileSync(
    seenPath,
    JSON.stringify({ catalogSha: sha, uuids: assets.map((a) => a.uuid.toLowerCase()).sort() }) + "\n",
  );

if (args.includes("--init-seen")) {
  writeSeen();
  process.stdout.write(`Recorded ${String(assets.length)} pieces of catalog ${sha} as seen (${seenPath}).\n`);
  process.exit(0);
}
if (!existsSync(seenPath))
  throw new Error(
    `No seen list (${seenPath}). Run once with --init-seen on the catalog the palettes were curated from.`,
  );
const seen = new Set((JSON.parse(readFileSync(seenPath, "utf8")) as { uuids: string[] }).uuids);
const rejected = existsSync(rejectedPath)
  ? (JSON.parse(readFileSync(rejectedPath, "utf8")) as { entries: Array<{ uuid: string }> }).entries.map((e) =>
      e.uuid.toLowerCase(),
    )
  : [];
const unseen = assets.filter((a) => !seen.has(a.uuid.toLowerCase()));

const out = classifyNew(assets, bundledPalettes().palettes, { seen, exclude: new Set(rejected) });
const byUuid = new Map(assets.map((a) => [a.uuid.toLowerCase(), a]));
const batch: Batch = existsSync(batchPath)
  ? (JSON.parse(readFileSync(batchPath, "utf8")) as Batch)
  : { description: "", entries: [] };
const have = new Set(batch.entries.map((e) => `${e.uuid}\u0000${e.theme}\u0000${e.to}`));
let added = 0;
let addedLoose = 0;
for (const p of out.pieces) {
  const a = byUuid.get(p.uuid);
  if (!a || have.has(`${p.uuid}\u0000${p.theme}\u0000${p.role}`)) continue;
  const v = p.variant;
  const e: AutoEntry = {
    theme: p.theme,
    to: p.role,
    uuid: p.uuid,
    name: a.name,
    kind: a.kind,
    size: a.size,
    originAt: a.originAt,
    boundsCenter: a.boundsCenter,
    lengthAxis: v.geom.lengthAxis ?? "square",
    footprintCells: a.footprintCells,
    ...(v.variant !== undefined ? { variant: v.variant } : {}),
    ...(v.weight !== undefined ? { weight: v.weight } : {}),
    ...(v.rot !== undefined ? { rot: v.rot } : {}),
    ...(v.offset !== undefined ? { offset: v.offset } : {}),
    ...(v.facing !== undefined ? { facing: v.facing } : {}),
    ...(v.stack !== undefined ? { stack: v.stack } : {}),
    minGenerator: GENERATOR_VERSION,
    confidence: "sure",
    basis: "sibling",
    sibling: p.siblings[0] ?? "",
    batch: `auto-${today}`,
  };
  batch.entries.push(e);
  added++;
  if (p.where === "user") addedLoose++;
}
batch.description =
  "Catalog pieces the shared classifier (src/palette/autoRoles.ts, the sibling rule) placed surely in an existing role, " +
  "written by scripts/classify-catalog.ts after a game update and read by import-palette-draft.ts: each joins its " +
  "role after the curated pieces, visible from generator `minGenerator` on. Promote a piece to a curated list to " +
  "review its tone or facing; reject one in data/catalog-review/rejected.json (never committed).";
writeFileSync(batchPath, JSON.stringify(batch, null, 2) + "\n");
writeFileSync(
  reportPath,
  JSON.stringify(
    { catalog: catalogPath, catalogSha: sha, unseen: unseen.length, unsure: out.unsure, newKits: out.newKits },
    null,
    2,
  ) + "\n",
);
writeSeen();
process.stdout.write(
  `Catalog ${sha}: ${String(assets.length)} pieces, ${String(unseen.length)} not seen before, ${String(rejected.length)} rejected.\n` +
    `Batch: ${String(added)} new rows (${String(addedLoose)} loose dressing, ${String(added - addedLoose)} ` +
    `structural, lights or supports) in ${batchPath}.\n` +
    `Report: ${String(out.unsure.length)} unsure, ${String(out.newKits.length)} new kits in ${reportPath}.\n` +
    `Seen list refreshed. Next: review the batch diff, run import-palette-draft.ts, make a proof slab.\n`,
);
