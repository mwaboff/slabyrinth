/**
 * Writes the in-game proof slabs to data/test-slabs/ through the real pipeline
 * (WP1 validatePlan → WP2 resolvePlan → WP3 realize/chunk/encode):
 *   01-calibration.txt                 calibration probe regenerated in TypeScript (must equal data/calibration-slab.txt)
 *   02-single-room.txt (+ .v1.txt)    one room: walls + posts, doors in two walls, stairs, props with distinct fronts
 *   03-two-level-single-slab.txt       two stacked levels: the default build (one slab, no markers)
 *   03-two-level-multichunk/NN-*.txt   the same plan forced into 3 chunks (regression for corner alignment markers)
 * plus the plans used (*.plan.json) and a manifest. Run:  npx tsx packages/core/scripts/make-test-slabs.ts
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { calibrationAssetsFrom, calibrationSlabAssets, compileResolved } from "../src/compile";
import type { ExportBundle, SlabChunk } from "../src/contracts/compiler";
import type { MapPlan } from "../src/contracts/plan";
import { loadPalettes } from "../src/palette";
import { validatePlan } from "../src/plan";
import { resolvePlan } from "../src/resolve";
import { decodeDetailed, encode, encodeRaw, slabCodec, toHex } from "../src/slab";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const outDir = join(repo, "data", "test-slabs");
const cat = loadPalettes();

function check(plan: MapPlan): void {
  const v = validatePlan(plan);
  const errs = v.issues.filter((i) => i.severity === "error");
  if (errs.length) throw new Error(`${plan.title}: ${errs.map((e) => `${e.code} ${e.message}`).join("; ")}`);
  const r = resolvePlan(plan);
  const rerrs = r.issues.filter((i) => i.severity === "error");
  if (rerrs.length)
    throw new Error(`${plan.title} (resolve): ${rerrs.map((e) => `${e.code} ${e.message}`).join("; ")}`);
}

/**
 * 02: one stone room 8×6 (cells x 2..9, y 2..7), solid rock around it, so every wall is hosted in the rock and the
 * four outer corners get posts. Door in the NORTH wall at x=4 and in the EAST wall at y=6. A stair run in the
 * north-east corner climbs NORTH (cells (9,6),(9,5),(9,4)) to a small mezzanine on level 2 (elevation 2.5).
 * Props are all at rot 0 (assumed front = south) except the chairs, which face the table.
 */
const singleRoom: MapPlan = {
  schema: "slabyrinth/plan@1",
  generator: 1,
  id: "5a1b0001-0000-4000-8000-000000000002",
  title: "Proof 02 - single room",
  kind: "dungeon",
  seed: 2,
  theme: "stone_dungeon",
  levels: [
    {
      id: "room",
      name: "Room",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 12, h: 10 },
      base: { type: "solid" },
      areas: [
        {
          id: "hall",
          kind: "room",
          name: "Proof room",
          key: "1",
          shape: { type: "rect", x: 2, y: 2, w: 8, h: 6 },
        },
        // v5 (verify stage, 2026-11-18): each door now leads into a short corridor instead of solid rock
        { id: "n_stub", kind: "corridor", shape: { type: "rect", x: 4, y: 0, w: 1, h: 2 } },
        { id: "e_stub", kind: "corridor", shape: { type: "rect", x: 10, y: 7, w: 2, h: 1 } },
      ],
      openings: [
        { id: "door_n", kind: "door", between: ["hall", "n_stub"] },
        // was at (9,6) E, where the cell inside the door is the bottom step of the stairs (verify_door_blocked /
        // opening_blocked); moved one cell south, clear of the stair run (9,6)→(9,4)
        { id: "door_e", kind: "door", between: ["hall", "e_stub"] },
      ],
      walls: [],
      features: [
        { id: "chest", type: "chest", at: [3, 6], rot: 0 },
        { id: "bed", type: "bed", at: [2, 2], rot: 0, size: [1, 2] },
        { id: "shelf", type: "bookshelf", at: [5, 2], rot: 0, size: [2, 1] },
        { id: "table", type: "table", at: [5, 4], rot: 0, size: [2, 1] },
        { id: "chair_s", type: "chair", at: [5, 5], rot: 180 },
        { id: "chair_n", type: "chair", at: [6, 3], rot: 0 },
      ],
      terrain: [],
      labels: [],
    },
    {
      id: "mezz",
      name: "Mezzanine",
      elevation: 2.5,
      bounds: { x: 0, y: 0, w: 12, h: 10 },
      base: { type: "void" },
      areas: [
        {
          id: "landing",
          kind: "room",
          name: "Landing",
          walls: "none",
          shape: { type: "rect", x: 8, y: 3, w: 2, h: 4 },
        },
      ],
      openings: [],
      walls: [],
      features: [],
      terrain: [],
      labels: [],
    },
  ],
  links: [
    { id: "stairs", kind: "stairs", from: { level: "room", at: [9, 6] }, to: { level: "mezz" }, dir: "N" },
  ],
};

/**
 * 03: two stacked dungeon levels joined by stairs. Level 1: three rooms and a corridor (≈ 26×16); level 2: two rooms
 * over the east half at elevation 2.5. Compiled with a small chunk budget so level 1 splits into several chunks;
 * every chunk carries the same two corner markers (south-west at ground level, north-east raised to the top).
 */
const twoLevel: MapPlan = {
  schema: "slabyrinth/plan@1",
  generator: 1,
  id: "5a1b0001-0000-4000-8000-000000000003",
  title: "Proof 03 - two levels, multi-chunk",
  kind: "dungeon",
  seed: 3,
  theme: "stone_dungeon",
  levels: [
    {
      id: "lower",
      name: "Lower",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 30, h: 20 },
      base: { type: "solid" },
      areas: [
        { id: "west", kind: "room", name: "West hall", shape: { type: "rect", x: 2, y: 2, w: 8, h: 10 } },
        { id: "east", kind: "room", name: "East hall", shape: { type: "rect", x: 18, y: 2, w: 9, h: 8 } },
        { id: "south", kind: "room", name: "South room", shape: { type: "rect", x: 14, y: 12, w: 8, h: 6 } },
        { id: "hall", kind: "corridor", shape: { type: "rect", x: 10, y: 5, w: 8, h: 2 } },
        { id: "link_s", kind: "corridor", shape: { type: "rect", x: 17, y: 10, w: 2, h: 2 } },
      ],
      openings: [
        { id: "o1", kind: "door", between: ["west", "hall"] },
        { id: "o2", kind: "double_door", between: ["hall", "east"], width: 2 },
        { id: "o3", kind: "door", between: ["east", "link_s"] },
        { id: "o4", kind: "door", between: ["link_s", "south"] },
      ],
      walls: [],
      features: [
        { id: "chest1", type: "chest", at: [3, 3] },
        { id: "barrel1", type: "barrel", at: [8, 10] },
        { id: "statue1", type: "statue", at: [15, 13] },
        { id: "altar1", type: "altar", at: [17, 15], size: [3, 2] },
      ],
      terrain: [],
      labels: [],
    },
    {
      id: "upper",
      name: "Upper",
      elevation: 2.5,
      bounds: { x: 0, y: 0, w: 30, h: 20 },
      base: { type: "void" },
      areas: [
        // h 7 (was 4): the gallery now covers the stairwell (25,6..8), so the stairs arrive in it instead of at a
        // wall (found by verify_stairs_arrival_blocked); the tower, listed after, still claims its own cells
        { id: "gallery", kind: "room", name: "Gallery", shape: { type: "rect", x: 18, y: 2, w: 9, h: 7 } },
        { id: "tower", kind: "room", name: "Tower room", shape: { type: "rect", x: 20, y: 6, w: 5, h: 4 } },
      ],
      openings: [{ id: "o5", kind: "door", between: ["gallery", "tower"] }],
      walls: [],
      features: [{ id: "chest2", type: "chest", at: [19, 3] }],
      terrain: [],
      labels: [],
    },
  ],
  links: [
    { id: "up", kind: "stairs", from: { level: "lower", at: [25, 8] }, to: { level: "upper" }, dir: "N" },
  ],
};

function main(): void {
  // Keep README.md (hand-written) and the previously pasted versions; replace everything generated.
  rmSync(join(outDir, "03-two-level-multichunk"), { recursive: true, force: true });
  mkdirSync(join(outDir, "03-two-level-multichunk"), { recursive: true });
  const manifest: Record<string, unknown> = {
    generatedBy: "packages/core/scripts/make-test-slabs.ts",
    resolver: "WP2 resolvePlan (real)",
    slabs: {},
  };
  const slabs = manifest["slabs"] as Record<string, unknown>;
  const when = "2026-11-18T00:00:00Z";
  const diag = (b: ExportBundle): string[] =>
    b.diagnostics.filter((d) => d.severity !== "info").map((d) => `${d.severity} ${d.code}: ${d.message}`);

  // 01 calibration
  const cal = encode(calibrationSlabAssets(calibrationAssetsFrom(cat)));
  const ref = decodeDetailed(readFileSync(join(repo, "data", "calibration-slab.txt"), "utf8"));
  const same = toHex(encodeRaw(decodeDetailed(cal.slab).assets)) === toHex(ref.raw);
  if (!same) throw new Error("calibration slab differs from data/calibration-slab.txt");
  writeFileSync(join(outDir, "01-calibration.txt"), cal.slab + "\n");
  slabs["01-calibration.txt"] = {
    assets: 130,
    compressedBytes: cal.compressedBytes,
    matchesResearchSlab: same,
  };

  // 02 single room (both levels in one slab by default). The version pasted on 2026-11-18 is kept as v1.
  check(singleRoom);
  // Every version pasted in game is kept: when the output changes, the current file is archived as the next
  // free 02-single-room.vN.txt (v1 first round trip, v2 lintel experiment, v3 chair front misread).
  const current = join(outDir, "02-single-room.txt");
  const archive = (next: string): void => {
    if (!existsSync(current) || readFileSync(current, "utf8") === next) return;
    let n = 1;
    while (existsSync(join(outDir, `02-single-room.v${n}.txt`))) n++;
    copyFileSync(current, join(outDir, `02-single-room.v${n}.txt`));
  };
  writeFileSync(join(outDir, "02-single-room.plan.json"), JSON.stringify(singleRoom, null, 2) + "\n");
  const b2 = compileResolved(resolvePlan(singleRoom), cat, slabCodec, { createdAt: when });
  if (b2.chunks.length !== 1) throw new Error(`02 expected one chunk, got ${b2.chunks.length}`);
  const slab2 = (b2.chunks[0]?.slab ?? "") + "\n";
  archive(slab2);
  writeFileSync(current, slab2);
  slabs["02-single-room.txt"] = {
    assets: b2.stats.totalAssets,
    compressedBytes: b2.chunks[0]?.compressedBytes,
    diagnostics: b2.diagnostics.map((d) => `${d.severity} ${d.code}: ${d.message}`),
  };

  // 03 two levels: (a) the default build = ONE slab; (b) forced multi-chunk (small budget) kept for regression
  check(twoLevel);
  writeFileSync(join(outDir, "03-two-level.plan.json"), JSON.stringify(twoLevel, null, 2) + "\n");
  const b3a = compileResolved(resolvePlan(twoLevel), cat, slabCodec, { createdAt: when });
  if (b3a.chunks.length !== 1 || b3a.chunks[0]?.hasAlignmentMarkers)
    throw new Error("03a: expected one slab, no markers");
  writeFileSync(join(outDir, "03-two-level-single-slab.txt"), (b3a.chunks[0]?.slab ?? "") + "\n");
  slabs["03-two-level-single-slab.txt"] = {
    levels: b3a.chunks[0]?.levelIds,
    assets: b3a.stats.totalAssets,
    compressedBytes: b3a.chunks[0]?.compressedBytes,
    diagnostics: diag(b3a),
  };
  const b3 = compileResolved(resolvePlan(twoLevel), cat, slabCodec, { fill: 0.02, createdAt: when });
  const boxes = new Set(
    b3.chunks.map((c) => {
      const a = decodeDetailed(c.slab).assets;
      return JSON.stringify(
        ["sx", "sy", "sz"].map((k) => [
          Math.min(...a.map((x) => x[k as "sx"])),
          Math.max(...a.map((x) => x[k as "sx"])),
        ]),
      );
    }),
  );
  if (b3.chunks.length < 3 || boxes.size !== 1 || !b3.chunks.every((c) => c.hasAlignmentMarkers))
    throw new Error("03b: expected ≥3 chunks with identical boxes and markers");
  const fileOf = (c: SlabChunk, i: number): string => `${String(i + 1).padStart(2, "0")}-${c.id}.txt`;
  b3.chunks.forEach((c, i) => {
    writeFileSync(join(outDir, "03-two-level-multichunk", fileOf(c, i)), c.slab + "\n");
  });
  slabs["03-two-level-multichunk"] = {
    note: "forced with fill 0.02 (≈ 614-byte chunks) to exercise alignment; the default build of this plan is one slab",
    chunks: b3.chunks.map((c, i) => ({
      file: fileOf(c, i),
      levels: c.levelIds,
      label: c.label,
      assets: c.assetCount,
      compressedBytes: c.compressedBytes,
      cellRect: c.cellRect,
    })),
    sharedBox: JSON.parse([...boxes][0] ?? "null") as unknown,
    diagnostics: diag(b3),
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
}

main();
