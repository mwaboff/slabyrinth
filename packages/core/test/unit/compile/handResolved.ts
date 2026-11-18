/**
 * Hand-written ResolvedPlan builder for compiler tests (independent of WP2's resolver):
 * a level from a character grid — '#' solid rock, '.' open floor, ' ' void, 'o' open without floor,
 * digits '1'..'8' open floor raised by that many quarter tiles. Walls go on every open/non-open edge and are
 * hosted by the non-open side (resolver host rule 1).
 */
import type { LevelId, Material, OpeningKind, Side, Vec2 } from "../../../src/contracts/plan";
import {
  CELL,
  CELL_FLAG,
  EDGE,
  type ResolvedFeature,
  type ResolvedLevel,
  type ResolvedLink,
  type ResolvedOpening,
  type ResolvedPlan,
} from "../../../src/contracts/resolved";

export interface HandDoor {
  x: number;
  y: number;
  side: Side;
  kind?: OpeningKind;
  width?: number;
}
export interface HandLevel {
  id: LevelId;
  elevation?: number;
  x0?: number;
  y0?: number;
  rows: string[];
  theme?: string;
  material?: Material;
  wallStyle?: string;
  wallHeight?: number;
  doors?: HandDoor[];
  features?: Array<Partial<ResolvedFeature> & Pick<ResolvedFeature, "id" | "type" | "at">>;
}

export function handLevel(h: HandLevel): ResolvedLevel {
  const x0 = h.x0 ?? 0;
  const y0 = h.y0 ?? 0;
  const H = h.rows.length;
  const W = Math.max(...h.rows.map((r) => r.length));
  const ch = (lx: number, ly: number): string =>
    lx < 0 || ly < 0 || lx >= W || ly >= H ? " " : (h.rows[ly]?.[lx] ?? " ");
  const isOpen = (c: string): boolean => c === "." || c === "o" || /[1-8]/.test(c);
  const state: number[] = [],
    area: number[] = [],
    material: number[] = [],
    height: number[] = [],
    flags: number[] = [],
    theme: number[] = [];
  for (let ly = 0; ly < H; ly++) {
    for (let lx = 0; lx < W; lx++) {
      const c = ch(lx, ly);
      const open = isOpen(c);
      state.push(c === "#" ? CELL.SOLID : open ? CELL.OPEN : CELL.VOID);
      area.push(open ? 1 : 0);
      material.push(open && c !== "o" ? 1 : 0);
      height.push(/[1-8]/.test(c) ? Number(c) : 0);
      flags.push(c === "o" ? CELL_FLAG.NO_FLOOR : 0);
      theme.push(0);
    }
  }
  const edgeGrid = (count: number): ResolvedLevel["hEdges"] => ({
    kind: new Array<number>(count).fill(EDGE.NONE),
    ref: new Array<number>(count).fill(0xffff),
    height: new Array<number>(count).fill(0),
    host: new Array<number>(count).fill(1),
  });
  const hE = edgeGrid(W * (H + 1));
  const vE = edgeGrid((W + 1) * H);
  const setWall = (g: ResolvedLevel["hEdges"], i: number, aOpen: boolean, bOpen: boolean): void => {
    if (aOpen === bOpen) return;
    g.kind[i] = EDGE.WALL;
    g.ref[i] = 0;
    g.height[i] = h.wallHeight ?? 2;
    g.host[i] = aOpen ? 1 : 0;
  };
  for (let ly = 0; ly <= H; ly++)
    for (let lx = 0; lx < W; lx++) setWall(hE, ly * W + lx, isOpen(ch(lx, ly - 1)), isOpen(ch(lx, ly)));
  for (let ly = 0; ly < H; ly++)
    for (let lx = 0; lx <= W; lx++)
      setWall(vE, ly * (W + 1) + lx, isOpen(ch(lx - 1, ly)), isOpen(ch(lx, ly)));
  const openings: ResolvedOpening[] = [];
  for (const [k, d] of (h.doors ?? []).entries()) {
    const width = d.width ?? 1;
    const orientation: "h" | "v" = d.side === "N" || d.side === "S" ? "h" : "v";
    const start: Vec2 =
      d.side === "N"
        ? [d.x, d.y]
        : d.side === "S"
          ? [d.x, d.y + 1]
          : d.side === "W"
            ? [d.x, d.y]
            : [d.x + 1, d.y];
    for (let j = 0; j < width; j++) {
      const lx = start[0] - x0 + (orientation === "h" ? j : 0);
      const ly = start[1] - y0 + (orientation === "v" ? j : 0);
      const g = orientation === "h" ? hE : vE;
      const i = orientation === "h" ? ly * W + lx : ly * (W + 1) + lx;
      g.kind[i] = EDGE.OPENING;
      g.ref[i] = k;
    }
    openings.push({
      id: `door${k}`,
      kind: d.kind ?? "door",
      orientation,
      start,
      width,
      sides: ["a", null],
      wallStyle: (h.wallStyle ?? "wall") as ResolvedOpening["wallStyle"],
      theme: h.theme ?? "stone_dungeon",
    });
  }
  const features: ResolvedFeature[] = (h.features ?? []).map((f) => ({
    size: [1, 1],
    rot: 0,
    rotFine: f.rot ?? 0,
    baseHeight: (h.elevation ?? 0) + 0.5,
    theme: h.theme ?? "stone_dungeon",
    blocking: true,
    ...f,
  }));
  return {
    id: h.id,
    name: h.id,
    elevation: h.elevation ?? 0,
    bounds: { x: x0, y: y0, w: W, h: H },
    cells: { state, area, material, height, flags, theme },
    areaIds: ["a"],
    materials: [h.material ?? "flagstone"],
    themes: [h.theme ?? "stone_dungeon"],
    wallStyles: [(h.wallStyle ?? "wall") as ResolvedLevel["wallStyles"][number]],
    hEdges: hE,
    vEdges: vE,
    areas: [],
    openings,
    features,
    labels: [],
  };
}

export function handPlan(levels: ResolvedLevel[], links: ResolvedLink[] = []): ResolvedPlan {
  return { planId: "hand", planVersion: 1, generator: 1, levels, links, issues: [], hash: "hand" };
}
