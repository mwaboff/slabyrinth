import { describe, expect, it } from "vitest";
import { countPlanRooms, isRoomArea } from "../../../src/plan";
import type { Area, MapPlan } from "../../../src/contracts/plan";

const rect = { type: "rect", x: 0, y: 0, w: 2, h: 2 } as const;
const area = (id: string, kind: Area["kind"], key?: string): Area => ({
  id,
  kind,
  shape: rect,
  ...(key !== undefined ? { key } : {}),
});

describe("room count rule", () => {
  // A plan made whole by create_plan: rooms carry no keys (the status bar used to say "0 rooms").
  const plan = {
    levels: [
      {
        id: "mine",
        areas: [
          area("a1", "room"),
          area("c1", "corridor"),
          area("g", "cave"),
          area("z", "zone"),
          area("c2", "corridor", "7"),
        ],
      },
      { id: "inn", areas: [area("b", "room", "1"), area("p", "courtyard", "2"), area("h", "building")] },
    ],
  } as unknown as Pick<MapPlan, "levels">;

  it("counts room-like kinds keyed or not, plus explicitly numbered areas; not corridors or zones", () => {
    expect(isRoomArea({ kind: "room" })).toBe(true);
    expect(isRoomArea({ kind: "corridor" })).toBe(false);
    expect(isRoomArea({ kind: "zone" })).toBe(false);
    expect(isRoomArea({ kind: "corridor", key: "7" })).toBe(true);
    expect(countPlanRooms(plan, "mine")).toBe(3);
    expect(countPlanRooms(plan, "inn")).toBe(3);
    expect(countPlanRooms(plan)).toBe(6);
    expect(countPlanRooms(null)).toBe(0);
  });
});
