/** Select a room on the map from anywhere (chat references, cards, recap). */
import { emptySel, useMap } from "../../stores/map";
import { useProject } from "../../stores/project";

export function findRoomByKey(key: string): { levelId: string; areaId: string; name: string } | null {
  const plan = useProject.getState().snap?.plan;
  for (const l of plan?.levels ?? [])
    for (const a of l.areas)
      if (a.key === key) return { levelId: l.id, areaId: a.id, name: a.name ?? `Room ${key}` };
  return null;
}

export function selectRoom(levelId: string, areaId: string): void {
  const m = useMap.getState();
  m.setTab("map");
  m.setLevel(levelId);
  m.select({ ...emptySel(), areaIds: [areaId] });
  window.dispatchEvent(new CustomEvent("slab:reveal", { detail: areaId }));
}

export function selectRoomByKey(key: string): void {
  const r = findRoomByKey(key);
  if (r) selectRoom(r.levelId, r.areaId);
}
