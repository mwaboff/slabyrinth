/**
 * Design brief helpers: AI updates never overwrite fields the GM set by hand (UX §5.1).
 */
import type { DesignBrief } from "../contracts/plan";
import { canonicalJson } from "../util/canonical";
import { h64hex } from "../util/hash";
import { BriefPatchSchema } from "./inputs";
import type { UpdateBriefInput } from "./tools";

export interface BriefMergeResult {
  brief: DesignBrief;
  updated: Array<keyof DesignBrief>;
  /** Fields the GM set by hand, left unchanged. */
  skipped: Array<keyof DesignBrief>;
}

export function mergeBrief(brief: DesignBrief, set: UpdateBriefInput["set"]): BriefMergeResult {
  const next: Record<string, unknown> = { ...brief };
  const updated: Array<keyof DesignBrief> = [];
  const skipped: Array<keyof DesignBrief> = [];
  for (const key of Object.keys(set).sort() as Array<keyof DesignBrief>) {
    const value = set[key];
    if (value === undefined) continue;
    if (brief[key]?.source === "user") {
      skipped.push(key);
      continue;
    }
    next[key] = { value, source: "ai" };
    updated.push(key);
  }
  return { brief: next, updated, skipped };
}

/** A patch of the brief by the GM (brief:update): `null` clears a field, `undefined` leaves it alone. */
export type BriefPatch = { [K in keyof DesignBrief]?: NonNullable<DesignBrief[K]>["value"] | null };

/** Checks a brief patch from outside (IPC): every value must be one update_brief would accept, or null. */
export function parseBriefPatch(
  set: unknown,
): { ok: true; patch: BriefPatch } | { ok: false; message: string } {
  const r = BriefPatchSchema.safeParse(set);
  if (r.success) return { ok: true, patch: r.data as BriefPatch };
  const first = r.error.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return { ok: false, message: `That brief value isn't valid (${where}${first?.message ?? "invalid"}).` };
}

/** The GM's own edit of the brief: a set value becomes the GM's (source "user"); null removes the field. */
export function patchBrief(brief: DesignBrief, set: BriefPatch): DesignBrief {
  const next: Record<string, unknown> = { ...brief };
  for (const [k, v] of Object.entries(set)) {
    if (v === null) Reflect.deleteProperty(next, k);
    else next[k] = { value: v, source: "user" };
  }
  return next;
}

/** Stable hash of the brief (values and sources), for Conversation.modelSeen.briefHash. */
export function briefHash(brief: DesignBrief): string {
  return h64hex(canonicalJson(brief));
}
