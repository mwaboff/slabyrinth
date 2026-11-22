/**
 * Build view model. Export ruling (2026-11-18): the default build is ONE slab containing every level; only a
 * build that does not fit is split into chunks, and a chunk may span several levels. This module turns a
 * BuildRecord (+ the ExportBundle when in memory) into an ordered list of slabs, whatever per-level layout the
 * record uses (a spanning chunk listed under each of its levels is merged by id).
 */
import type { ExportBundle, SlabChunk } from "@slabyrinth/core";
import type { BuildRecord } from "../../../shared/project";

export interface SlabRow {
  id: string;
  /** 1-based paste order across the build. */
  step: number;
  label: string;
  columns: string | null;
  levelIds: string[];
  sizeBytes: number;
  limitBytes: number;
  copiedAt: string | null;
  pasted: boolean;
  changed: boolean | null;
  region: { x0: number; y0: number; x1: number; y1: number };
}

export interface BuildModel {
  buildId: string;
  version: number;
  createdAt: string;
  single: boolean;
  slabs: SlabRow[];
  /** Levels in paste/placement order with placement text. */
  levels: Array<{ levelId: string; placement: BuildRecord["levels"][number]["placement"] }>;
  stacking: BuildRecord["settings"]["stacking"];
  assetSource: BuildRecord["assetSource"];
  substitutions: BuildRecord["substitutions"];
  pastedCount: number;
  copiedCount: number;
  /**
   * Where the cursor goes for a map pasted from beside it: recorded on the build (so the paste steps survive a restart
   * or a project switch), else the bundle in memory; null for the plain steps (talespire/pasteSteps.ts).
   */
  pasteAnchor: NonNullable<ExportBundle["pasteAnchor"]> | null;
}

/** Every level a bundle chunk contains, lowest first. */
export function chunkLevelIds(c: SlabChunk): string[] {
  return c.levelIds.length > 0 ? [...c.levelIds] : [c.levelId];
}

/** BuildRecord chunks carry `levelIds` since 2026-11-18 (absent in older builds). */
function recordLevelIds(c: BuildRecord["levels"][number]["chunks"][number]): string[] | null {
  return c.levelIds !== undefined && c.levelIds.length > 0 ? [...c.levelIds] : null;
}

export function buildModel(record: BuildRecord, bundle: ExportBundle | null): BuildModel {
  const byId = new Map<string, SlabRow>();
  const order: string[] = [];
  const levels = [...record.levels].sort((a, b) => a.pasteOrder - b.pasteOrder);
  for (const l of levels) {
    for (const c of l.chunks) {
      const existing = byId.get(c.id);
      if (existing) {
        if (!existing.levelIds.includes(l.levelId)) existing.levelIds.push(l.levelId);
        existing.pasted = existing.pasted || c.pasted;
        if (existing.copiedAt === null && c.copiedAt !== undefined) existing.copiedAt = c.copiedAt;
        continue;
      }
      order.push(c.id);
      byId.set(c.id, {
        id: c.id,
        step: 0,
        label: c.label,
        columns: null,
        levelIds: recordLevelIds(c) ?? [l.levelId],
        sizeBytes: c.sizeBytes,
        limitBytes: c.limitBytes,
        copiedAt: c.copiedAt ?? null,
        pasted: c.pasted,
        changed: c.changedSinceBuild ?? null,
        region: c.region,
      });
    }
  }
  if (bundle) {
    for (const bc of bundle.chunks) {
      const row = byId.get(bc.id);
      if (!row) continue;
      row.levelIds = chunkLevelIds(bc).filter((id, i, a) => a.indexOf(id) === i);
      row.columns = bc.columns;
    }
  }
  const slabs = order.map((id) => byId.get(id) as SlabRow);
  // Single-slab default: the one slab holds every placed level, whichever level entry hosts it.
  if (slabs.length === 1 && slabs[0] && (bundle === null || bundle.chunks.length === 1)) {
    const fromBundle = bundle?.chunks[0] ? chunkLevelIds(bundle.chunks[0]) : null;
    slabs[0].levelIds = fromBundle && fromBundle.length > 1 ? fromBundle : levels.map((l) => l.levelId);
  }
  slabs.sort((a, b) => a.region.x0 - b.region.x0 || a.region.y0 - b.region.y0);
  // keep the record's order when it is explicit (globalStep) — chunk index order within the record
  const stepOf = new Map<string, number>();
  for (const l of levels) for (const c of l.chunks) if (!stepOf.has(c.id)) stepOf.set(c.id, c.globalStep);
  slabs.sort((a, b) => (stepOf.get(a.id) ?? 0) - (stepOf.get(b.id) ?? 0));
  slabs.forEach((s, i) => (s.step = i + 1));
  return {
    buildId: record.id,
    version: record.versionNumber,
    createdAt: record.createdAt,
    single: slabs.length === 1,
    slabs,
    levels: levels.map((l) => ({ levelId: l.levelId, placement: l.placement })),
    stacking: record.settings.stacking,
    assetSource: record.assetSource,
    substitutions: record.substitutions,
    pastedCount: slabs.filter((s) => s.pasted).length,
    copiedCount: slabs.filter((s) => s.copiedAt !== null || s.pasted).length,
    pasteAnchor: record.pasteAnchor ?? bundle?.pasteAnchor ?? null,
  };
}

/** "L1 + L2", "L2 only", "all 3 levels". */
export function levelsLabel(levelIds: string[], shortName: (id: string) => string, total: number): string {
  if (levelIds.length === total && total > 2) return `all ${total} levels`;
  return levelIds.map(shortName).join(" + ");
}

export function sizeState(bytes: number, limit: number): "ok" | "near" | "over" {
  if (bytes > limit) return "over";
  if (bytes >= limit * 0.8) return "near";
  return "ok";
}
