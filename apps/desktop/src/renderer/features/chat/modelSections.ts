/**
 * Pure list-building for the model picker: splits descriptors into the curated section and "Other models",
 * drops other-models that are the same model as a curated one (alias vs dated snapshot id), and orders them.
 * Nothing here knows model names: identity comes from the ids themselves.
 */
import type { ModelDescriptor } from "../../../main/agent/provider/types";

/** "claude-opus-4-1-20250805" and "claude-opus-4-1" (alias) and "…-latest" share one base id. */
export function modelBaseId(id: string): string {
  return id.replace(/-(?:\d{8}|latest)$/, "");
}

export interface ModelSections {
  curated: ModelDescriptor[];
  other: ModelDescriptor[];
}

function time(m: ModelDescriptor): number {
  const t = m.createdAt ? Date.parse(m.createdAt) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

export function buildModelSections(models: readonly ModelDescriptor[]): ModelSections {
  const usable = models.filter((m) => m.status !== "unavailable");
  const curated = usable.filter((m) => m.guidance !== undefined);
  const represented = new Set(curated.map((m) => modelBaseId(m.modelId)));
  const seen = new Set<string>();
  const other = usable
    .filter((m) => m.guidance === undefined && !represented.has(modelBaseId(m.modelId)))
    .sort((a, b) => time(b) - time(a) || a.modelId.localeCompare(b.modelId))
    .filter((m) => {
      // Alias + dated snapshot of the same model: keep the first (newest, then alphabetical → alias sorts first).
      const base = modelBaseId(m.modelId);
      if (seen.has(base)) return false;
      seen.add(base);
      return true;
    });
  return { curated, other };
}

/** Full, version-bearing label for a non-curated row ("Claude Opus 4.1"); never just the family. */
export function otherModelLabel(m: ModelDescriptor): string {
  return m.displayName.trim() || m.modelId;
}
