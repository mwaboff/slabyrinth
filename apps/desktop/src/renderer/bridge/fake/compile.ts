/**
 * Simulated compile for the fake bridge. Follows the 2026-11-18 export ruling: the default build is ONE
 * slab containing every level (stacked or side by side) whenever it fits under the limit; only an oversized
 * build is split into spatial chunks, and a chunk may then span several levels.
 *
 * Chunks carry levelIds (contract, 2026-11-18); each is recorded once in the BuildRecord, under its lowest level.
 */
import type { ChunkOptions, CompileDiagnostic, ExportBundle, MapPlan, SlabChunk } from "@slabyrinth/core";
import { validatePlan } from "@slabyrinth/core";
import { fakeRules } from "./rules";
import type { BuildRecord } from "../../../shared/project";
import { colLetters } from "../../lib/format";

const LIMIT = 30720;
const TARGET = Math.round(LIMIT * 0.9);
const LABELS: Record<number, string[]> = {
  2: ["West", "East"],
  3: ["West", "Centre", "East"],
  4: ["West", "Centre-west", "Centre-east", "East"],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fakeSlab(seed: number, bytes: number): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let x = seed || 1;
  let s = "H4sIAAAAAAAACu";
  const len = Math.ceil((bytes * 4) / 3);
  for (let i = s.length; i < len; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    s += abc[(x >>> 0) % 64] as string;
  }
  return s;
}

/** Rough compressed size of a level (cells + features), deterministic. */
export function levelBytes(l: MapPlan["levels"][number]): number {
  return (
    l.bounds.w * l.bounds.h * 10 + l.features.length * 60 + l.areas.length * 300 + l.terrain.length * 900
  );
}

export interface FakeCompileResult {
  bundle: ExportBundle;
  record: BuildRecord;
  slabText: Record<string, string>;
}

export type MultiLevelChunk = SlabChunk;

/**
 * Stand-in for the compiler's verify stage: plan playability issues mapped to verify_* diagnostics, plus the
 * automatic repairs the real verifier reports as info. Messages are GM-facing; hints are for the AI only.
 */
export function fakeVerify(plan: MapPlan): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  for (const i of validatePlan(plan, fakeRules()).issues) {
    const base = {
      stage: "verify" as const,
      message: i.message,
      ...(i.levelId !== undefined ? { levelId: i.levelId } : {}),
      ...(i.cell ? { cell: i.cell } : {}),
      ...(i.elementId !== undefined ? { elementId: i.elementId, elementIds: [i.elementId] } : {}),
      ...(i.hint !== undefined ? { hint: i.hint } : {}),
    };
    if (i.code === "opening_blocked")
      out.push({
        ...base,
        severity: "error",
        code: "verify_door_blocked",
        assets: ["Door - Dungeon", "Dungeon Stairs"],
      });
    else if (i.code === "opening_dead_end")
      out.push({ ...base, severity: "warning", code: "verify_door_leads_nowhere" });
    else if (i.code === "unreachable" || i.code === "area_sealed")
      out.push({ ...base, severity: "error", code: "verify_area_unreachable" });
    else if (i.code === "link_approach_blocked")
      out.push({ ...base, severity: "error", code: "verify_stairs_approach_blocked" });
  }
  const firstFeature = plan.levels
    .flatMap((l) => l.features.map((f) => ({ l, f })))
    .find((x) => x.f.type === "bookshelf" || x.f.type === "torch_wall");
  if (firstFeature) {
    out.push({
      severity: "info",
      code: "verify_prop_nudged",
      stage: "verify",
      levelId: firstFeature.l.id,
      cell: firstFeature.f.at,
      elementId: firstFeature.f.id,
      elementIds: [firstFeature.f.id],
      message: `The ${firstFeature.f.type.replace(/_/g, " ")} was pushed slightly out of the wall it was sinking into.`,
      repaired: "moved 0.1 tile into the room",
    });
  }
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function fakeCompile(
  plan: MapPlan,
  version: number,
  opts: ChunkOptions,
  createdAt: string,
  assetSource: "install" | "builtin",
): FakeCompileResult {
  const layout = opts.levelLayout ?? "stacked";
  const ordered =
    layout === "stacked" ? [...plan.levels].sort((a, b) => a.elevation - b.elevation) : [...plan.levels];
  const base = ordered[0]?.elevation ?? 0;
  const total = ordered.reduce((s, l) => s + levelBytes(l), 0);
  const n = total <= TARGET ? 1 : Math.min(4, Math.ceil(total / TARGET));
  const levelIds = ordered.map((l) => l.id);
  // Union of level bounds (levels share the global grid).
  const x = Math.min(...ordered.map((l) => l.bounds.x));
  const y = Math.min(...ordered.map((l) => l.bounds.y));
  const w = Math.max(...ordered.map((l) => l.bounds.x + l.bounds.w)) - x;
  const h = Math.max(...ordered.map((l) => l.bounds.y + l.bounds.h)) - y;

  const chunks: MultiLevelChunk[] = [];
  const slabText: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const x0 = x + Math.floor((w * i) / n);
    const x1 = x + Math.floor((w * (i + 1)) / n) - 1;
    const id = n === 1 ? "map" : `part-${String(i + 1).padStart(2, "0")}`;
    const seed = hash(`${plan.id}:${version}:${id}`);
    // A chunk contains the levels that have content in its columns (all of them, for these fixtures).
    const ids = ordered.filter((l) => l.bounds.x <= x1 && l.bounds.x + l.bounds.w - 1 >= x0).map((l) => l.id);
    const share = n === 1 ? total : Math.round(total / n);
    const bytes = Math.min(LIMIT - 900, Math.round(share * (0.92 + ((seed % 100) / 100) * 0.12)));
    const contentHash = hash(
      `${plan.id}:${JSON.stringify(ordered.map((l) => l.areas.map((a) => [a.id, a.shape])))}:${id}`,
    ).toString(16);
    const slab = fakeSlab(seed, bytes);
    slabText[id] = slab;
    chunks.push({
      id,
      levelId: ids[0] ?? levelIds[0] ?? "",
      levelIds: ids,
      index: i + 1,
      countInLevel: n,
      slab,
      compressedBytes: bytes,
      base64Length: slab.length,
      assetCount: Math.round(bytes / 9),
      bounds: { min: { x: x0, y: base, z: y }, max: { x: x1, y: base + 2.5 * ordered.length, z: y + h } },
      cellRect: { x: x0, y, w: x1 - x0 + 1, h },
      pasteNote:
        i === 0
          ? "Paste anywhere flat; this sets the alignment pillars."
          : "Paste on the same alignment pillars as slab 1.",
      hasAlignmentMarkers: n > 1 || opts.alignment === "always",
      label: n === 1 ? "Whole map" : (LABELS[n]?.[i] ?? `Part ${i + 1}`),
      columns: `${colLetters(x0 - x)}–${colLetters(x1 - x)}`,
      offsetFromFirst: { x: x0 - x, y: 0, z: 0 },
      contentHash,
    });
  }

  const placement: ExportBundle["levelPlacement"] = ordered.map((level, li) => {
    const storeys = Math.round((level.elevation - base) / 2.5);
    const kind = layout === "side_by_side" ? "side-by-side" : storeys === 0 ? "ground" : "storeys-up";
    const p: ExportBundle["levelPlacement"][number] = { levelId: level.id, pasteOrder: li + 1, kind };
    if (kind === "storeys-up") p.storeys = storeys;
    if (kind === "side-by-side" && li > 0) p.offsetSq = 10;
    return p;
  });

  const recordLevels: BuildRecord["levels"] = placement.map((p) => {
    const rl: BuildRecord["levels"][number] = {
      levelId: p.levelId,
      pasteOrder: p.pasteOrder,
      placement: { kind: p.kind },
      chunks: chunks
        .filter((c) => c.levelIds[0] === p.levelId) // recorded once, under its host level
        .map((c) => ({
          id: c.id,
          index: c.index,
          globalStep: c.index,
          label: c.label,
          region: {
            x0: c.cellRect.x,
            y0: c.cellRect.y,
            x1: c.cellRect.x + c.cellRect.w - 1,
            y1: c.cellRect.y + c.cellRect.h - 1,
          },
          sizeBytes: c.compressedBytes,
          limitBytes: LIMIT,
          contentHash: c.contentHash,
          offset: c.offsetFromFirst,
          pasted: false,
          levelIds: [...c.levelIds],
        })),
    };
    if (p.storeys !== undefined) rl.placement.storeys = p.storeys;
    if (p.offsetSq !== undefined) rl.placement.offsetSq = p.offsetSq;
    return rl;
  });

  const diags = fakeVerify(plan);
  const id = `build-${version}-${hash(createdAt).toString(36)}`;
  const totalAssets = chunks.reduce((s, c) => s + c.assetCount, 0);
  const substitutions: ExportBundle["substitutions"] =
    assetSource === "builtin"
      ? []
      : [
          {
            role: "wall.stone",
            wanted: { uuid: "w3", name: "Dungeon Wall 03" },
            used: { uuid: "w1", name: "Dungeon Wall 01" },
            count: 38,
          },
        ];
  const bundle: ExportBundle = {
    planId: plan.id,
    planVersion: version,
    resolvedHash: hash(JSON.stringify(plan)).toString(16),
    createdAt,
    chunks,
    diagnostics: diags,
    stats: {
      totalAssets,
      totalChunks: chunks.length,
      perLevel: ordered.map((l) => ({
        levelId: l.id,
        assets: Math.round(levelBytes(l) / 9),
        chunks: chunks.filter((c) => c.levelIds.includes(l.id)).length,
      })),
      droppedPlacements: 0,
    },
    instructions:
      n === 1
        ? "Paste the slab anywhere flat in build mode."
        : "Paste every slab on the same alignment pillars.",
    assetSource,
    substitutions,
    levelPlacement: placement,
  };
  const record: BuildRecord = {
    id,
    versionNumber: version,
    createdAt,
    catalogVersion: assetSource === "builtin" ? "builtin" : "2026-11-12",
    assetSource,
    settings: {
      stacking: layout,
      gapSq: 10,
      markers: opts.alignment ?? "multi-chunk",
      copyFormat: "plain",
      orientationHash: "o1",
      paletteHash: "p1",
    },
    levels: recordLevels,
    substitutions: substitutions.map((s) => ({
      role: s.role,
      wanted: s.wanted.name ?? s.wanted.uuid,
      used: s.used?.name ?? null,
      count: s.count,
    })),
    unmatchedAssets: [],
    diagnosticsSummary: {
      errors: diags.filter((d) => d.severity === "error").length,
      warnings: diags.filter((d) => d.severity === "warning").length + substitutions.length,
    },
  };
  return { bundle, record, slabText };
}

/** Slab count the fake compiler would produce (compile:estimate). */
export function estimateSlabs(plan: MapPlan): number {
  const total = plan.levels.reduce((s, l) => s + levelBytes(l), 0);
  return total <= TARGET ? 1 : Math.min(4, Math.ceil(total / TARGET));
}
