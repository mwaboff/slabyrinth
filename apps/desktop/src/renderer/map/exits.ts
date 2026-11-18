/** Exits of a room, generated from resolved geometry (UX §6.8: "W door → ②, E door → ⑤"). Pure. */
import type { ResolvedLevel, ResolvedLink, ResolvedOpening } from "@slabyrinth/core";

export interface Exit {
  side: "N" | "E" | "S" | "W";
  kind: string;
  /** Room key on the other side, or null (outside / unnumbered space). */
  toKey: string | null;
  toName: string | null;
  levelJump?: string;
}

const KIND: Record<string, string> = {
  door: "door",
  double_door: "double door",
  locked_door: "locked door",
  secret_door: "secret door",
  portcullis: "portcullis",
  archway: "arch",
  open: "opening",
  window: "window",
  arrow_slit: "arrow slit",
  bars: "bars",
};

function sideOf(o: ResolvedOpening, areaId: string): "N" | "E" | "S" | "W" | null {
  const [a, b] = o.sides;
  if (o.orientation === "h") return a === areaId ? "S" : b === areaId ? "N" : null;
  return a === areaId ? "E" : b === areaId ? "W" : null;
}

export function roomExits(level: ResolvedLevel, links: readonly ResolvedLink[], areaId: string): Exit[] {
  const areaById = new Map(level.areas.map((a) => [a.id, a]));
  const out: Exit[] = [];
  const keyed = (id: string | null, via: Set<string>): Array<{ key: string | null; name: string | null }> => {
    if (id === null) return [{ key: null, name: "outside" }];
    const a = areaById.get(id);
    if (!a) return [{ key: null, name: null }];
    if (a.key !== undefined) return [{ key: a.key, name: a.name ?? null }];
    // unnumbered corridor: follow one hop to the rooms it connects
    if (via.has(id)) return [];
    via.add(id);
    const next = level.openings
      .filter((o) => o.sides.includes(id))
      .flatMap((o) => keyed(o.sides[0] === id ? o.sides[1] : o.sides[0], via));
    return next.length > 0
      ? next.filter((n) => n.key !== areaId)
      : [{ key: null, name: a.name ?? "corridor" }];
  };
  for (const o of level.openings) {
    const side = sideOf(o, areaId);
    if (side === null) continue;
    const other = o.sides[0] === areaId ? o.sides[1] : o.sides[0];
    const targets = keyed(other, new Set([areaId]));
    const room = areaById.get(areaId);
    for (const t of targets.length > 0 ? targets : [{ key: null, name: null }]) {
      if (t.key !== null && t.key === room?.key) continue;
      out.push({ side, kind: KIND[o.kind] ?? o.kind, toKey: t.key, toName: t.name });
    }
  }
  for (const l of links) {
    const cells = l.fromLevel === level.id ? l.lowerCells : l.toLevel === level.id ? l.upperCells : [];
    const inRoom = cells.some(([x, y]) => {
      const i = (y - level.bounds.y) * level.bounds.w + (x - level.bounds.x);
      const ai = level.cells.area[i] ?? 0;
      return ai > 0 && level.areaIds[ai - 1] === areaId;
    });
    if (!inRoom) continue;
    const up = l.fromLevel === level.id;
    const other = up ? l.toLevel : l.fromLevel;
    out.push({
      side: l.dir,
      kind: `${l.kind.replace("_", " ")} ${up ? "up" : "down"}`,
      toKey: null,
      toName: null,
      levelJump: other,
    });
  }
  // de-duplicate identical lines
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.side}${e.kind}${e.toKey ?? e.toName ?? ""}${e.levelJump ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const SIDE_WORD = { N: "north", E: "east", S: "south", W: "west" } as const;

/** "Room 4, Hall of Pillars, 60 by 45 feet, exits west, north, east, south" (UX §13.3). */
export function roomA11yLabel(
  key: string | undefined,
  name: string | undefined,
  wFt: number,
  hFt: number,
  exits: readonly Exit[],
): string {
  const sides = [...new Set(exits.map((e) => SIDE_WORD[e.side]))];
  return `Room ${key ?? ""}, ${name ?? "unnamed"}, ${wFt} by ${hFt} feet${sides.length > 0 ? `, exits ${sides.join(", ")}` : ""}`;
}
