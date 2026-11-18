/**
 * Design brief helpers: AI updates never overwrite fields the GM set by hand (UX §5.1).
 */
import type { DesignBrief } from "../contracts/plan";
import { canonicalJson } from "../util/canonical";
import { h64hex } from "../util/hash";
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

/** Stable hash of the brief (values and sources), for Conversation.modelSeen.briefHash. */
export function briefHash(brief: DesignBrief): string {
  return h64hex(canonicalJson(brief));
}
