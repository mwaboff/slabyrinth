/**
 * The level tabs on the 3D tab: the one control for which levels the view shows. "All levels", then each level in the
 * Map's tab order; picking a level shows it and the levels below it (the ones above are hidden, to look inside), the
 * same as PgUp/PgDn and Alt+1…9. Picking a level also makes it the Map's level, so going back to the Map lands there.
 */
import type { MapPlan } from "@slabyrinth/core";
import { useMap } from "../../stores/map";
import { levelShort, orderedLevels } from "../../stores/project";
import { useView3d } from "../../stores/view3d";

/** Levels whose elevation is above the given one (hidden when the view shows up to it). */
export function levelsAbove(plan: MapPlan, levelId: string): MapPlan["levels"] {
  const at = plan.levels.find((l) => l.id === levelId);
  return at ? orderedLevels(plan).filter((l) => l.elevation > at.elevation) : [];
}

export function LevelCutTabs({ plan }: { plan: MapPlan }) {
  const cut = useView3d((s) => s.cutLevelId);
  const setCut = useView3d((s) => s.setCutLevel);
  const levels = orderedLevels(plan);
  const on = levels.some((l) => l.id === cut) ? cut : null;
  return (
    <div role="tablist" aria-label="Levels shown in 3D" className="stagebar__group">
      {levels.length > 1 && (
        <button
          role="tab"
          aria-selected={on === null}
          className={`tab${on === null ? " tab--on" : ""}`}
          title="Show every level"
          onClick={() => {
            setCut(null);
          }}
        >
          All levels
        </button>
      )}
      {levels.map((l) => {
        const short = levelShort(plan, l.id);
        const above = levelsAbove(plan, l.id);
        const selected = on === l.id || (levels.length === 1 && on === null);
        return (
          <button
            key={l.id}
            role="tab"
            aria-selected={selected}
            className={`tab${selected ? " tab--on" : ""}`}
            title={
              above.length === 0
                ? `${short} ${l.name} and everything below it`
                : `${short} ${l.name} and below; hides ${above.map((a) => levelShort(plan, a.id)).join(", ")} to look inside`
            }
            onClick={() => {
              setCut(l.id);
              useMap.getState().setLevel(l.id);
            }}
          >
            <span className="tab__lv">{short}</span>
            <span className="tab__name">{l.name}</span>
          </button>
        );
      })}
    </div>
  );
}
