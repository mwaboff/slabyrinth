/**
 * Settings > Experimental: "Maximum map size" (AppSettings.mapSize, core plan/sizeTiers.ts). The next change and the
 * next build use it; no restart. Costs measured with core's test/sweep/sizes.ts (docs/decisions.md 2026-11-22).
 */
import { SIZE_TIER_ORDER, type SizeTierId } from "@slabyrinth/core/plan";
import { useProject } from "../../stores/project";
import { useSettings } from "../../stores/settings";
import { tierAboveSetting, tierSize } from "../../../shared/sizeTier";
import type { AppSettings } from "../../../shared/project";

export const MAP_SIZE_LABEL: Record<SizeTierId, string> = {
  standard: `Standard (${tierSize("standard")})`,
  "large-512": tierSize("large-512"),
  "large-768": tierSize("large-768"),
  "large-1024": tierSize("large-1024"),
};

/** What each size costs, in one or two plain lines. */
export const MAP_SIZE_NOTE: Record<SizeTierId, string> = {
  standard: "The default. Changes and builds stay quick.",
  "large-512":
    "Each change to a map this big takes about 2 to 5 seconds, and a build about 4 seconds more. Up to about 1.2 GB of memory, and more slabs to paste.",
  "large-768":
    "Each change takes about 4 to 9 seconds, and a build about 8 seconds more. Up to about 2 GB of memory, and more slabs to paste.",
  "large-1024":
    "Each change takes about 6 to 16 seconds, and a build 12 to 18 seconds more. Up to about 2.6 GB of memory, and more slabs to paste. May be slow on a computer with less than 8 GB of memory.",
};

export function MapSizeSetting({ s }: { s: AppSettings }) {
  const update = useSettings((x) => x.update);
  const plan = useProject((x) => x.snap?.plan ?? null);
  const chosen = s.mapSize ?? "standard";
  const above = tierAboveSetting(chosen, plan);
  return (
    <>
      <div className="segctl segctl--fit" role="radiogroup" aria-label="Maximum map size">
        {SIZE_TIER_ORDER.map((id) => (
          <button
            key={id}
            role="radio"
            aria-checked={chosen === id}
            onClick={() => void update({ mapSize: id })}
          >
            {MAP_SIZE_LABEL[id]}
          </button>
        ))}
      </div>
      <span className={chosen === "standard" ? "muted" : "mapsize__warn"} role="note">
        {MAP_SIZE_NOTE[chosen]}
      </span>
      <span className="muted">
        Cells a side for one level. Applies from the next change and build; no restart needed.
      </span>
      {above !== null && (
        <span className="muted">
          The open map needs {tierSize(above)}, so it keeps that size whatever you choose here.
        </span>
      )}
    </>
  );
}
