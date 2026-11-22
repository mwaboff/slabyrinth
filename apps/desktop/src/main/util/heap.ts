/**
 * The main process's heap against the map size setting. The agent's plan checks and design review run on main's own
 * thread; at the experimental sizes they need room (docs/internal/handoff-size-tiers.md: main, the resolve worker and
 * the compile worker must each allow at least a 4 GB heap). Main cannot raise its own limit after start, so it says in
 * the log when the limit is too small for the size in use, where a bug report shows it.
 */
import { getHeapStatistics } from "node:v8";
import type { SizeTierId } from "@slabyrinth/core/plan";
import type { Logger } from "../logger";

/** The heap the experimental sizes need in one process (app.ts gives each compile worker this much). */
export const BIG_MAP_HEAP_MB = 4096;
/** V8 reports a 4 GB limit a little under 4096 MB. */
const SLACK_MB = 64;

/** A warning when this heap limit is too small for the size tier, else null. */
export function heapWarning(limitMb: number, tier: SizeTierId): string | null {
  if (tier === "standard" || limitMb + SLACK_MB >= BIG_MAP_HEAP_MB) return null;
  return `main heap limit ${String(Math.round(limitMb))} MB is below the ${String(BIG_MAP_HEAP_MB)} MB the ${tier} map size needs`;
}

/** Logs main's heap limit, as a warning when it is too small for `tier`. */
export function logMainHeap(
  logger: Logger,
  tier: SizeTierId,
  limitMb = getHeapStatistics().heap_size_limit / 2 ** 20,
): void {
  const warning = heapWarning(limitMb, tier);
  if (warning !== null) logger.warn(warning, { tier, heapLimitMb: Math.round(limitMb) });
  else logger.info("main heap", { tier, heapLimitMb: Math.round(limitMb) });
}
