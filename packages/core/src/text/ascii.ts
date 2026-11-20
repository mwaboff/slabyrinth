/**
 * ASCII view of a resolved level for the model (architecture §3.3 item 3).
 * Double resolution: a (2w+1)×(2h+1) character grid; odd/odd positions are cells, even positions are edges and
 * vertices. Levels (or crops) wider than 60 cells switch to 1 character per cell (no walls) with a hint.
 */
import type { LevelId, OpeningKind, PlanIssue, Vec2 } from "../contracts/plan";
import type { ResolvedLevel, ResolvedPlan } from "../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../contracts/resolved";
import { featureInfo } from "../gen/catalog";

export interface AsciiOptions {
  /** Crop to a cell rect (global coords). */
  region?: { x: number; y: number; w: number; h: number };
  /** Max cells across before switching to 1 char per cell (default 60). */
  maxDoubleWidth?: number;
  /** Print the legend (default true). */
  legend?: boolean;
  /** Level labels for link hints, e.g. { l1: "L1" }. */
  levelLabels?: Record<string, string>;
  /** Issues to mark: cells of issues on this level are drawn as "!" and listed under the map. */
  issues?: readonly PlanIssue[];
}

export const OPENING_CHAR: Record<OpeningKind, string> = {
  door: "d",
  double_door: "D",
  locked_door: "L",
  secret_door: "s",
  archway: "a",
  open: " ",
  window: "w",
  arrow_slit: "w",
  portcullis: "p",
  bars: "p",
};

const OPENING_NAME: Record<string, string> = {
  d: "door",
  D: "double door",
  L: "locked door",
  s: "secret door",
  a: "archway",
  w: "window/arrow slit",
  p: "portcullis/bars",
};

const FEATURE_POOL = "ABCEFGHIJKMNPQRTUVXYZbcefghijkmnoqrtuvxyz";

interface CellView {
  base: string;
  feat: string | null;
  featId: string | null;
}

export function asciiView(resolved: ResolvedPlan, levelId: LevelId, opts: AsciiOptions = {}): string {
  const lvl = resolved.levels.find((l) => l.id === levelId);
  if (!lvl) return `(no level "${levelId}")`;
  return asciiLevel(lvl, resolved, opts);
}

export function asciiLevel(
  lvl: ResolvedLevel,
  resolved: Pick<ResolvedPlan, "links"> | null,
  opts: AsciiOptions = {},
): string {
  const B = lvl.bounds;
  let rx0 = B.x;
  let ry0 = B.y;
  let rx1 = B.x + B.w;
  let ry1 = B.y + B.h;
  if (opts.region) {
    rx0 = Math.max(rx0, Math.floor(opts.region.x));
    ry0 = Math.max(ry0, Math.floor(opts.region.y));
    rx1 = Math.min(rx1, Math.floor(opts.region.x + opts.region.w));
    ry1 = Math.min(ry1, Math.floor(opts.region.y + opts.region.h));
  }
  const rw = Math.max(0, rx1 - rx0);
  const rh = Math.max(0, ry1 - ry0);
  if (rw === 0 || rh === 0) return "(empty region)";
  const W = B.w;
  const cellI = (gx: number, gy: number): number =>
    gx < B.x || gy < B.y || gx >= B.x + B.w || gy >= B.y + B.h ? -1 : (gy - B.y) * W + (gx - B.x);

  // feature chars
  const featChar = new Map<string, string>();
  const used = new Set<string>();
  const legendFeat: Array<[string, string]> = [];
  const featAt = new Map<number, { ch: string; id: string }>();
  for (const f of lvl.features) {
    const inView = f.at[0] < rx1 && f.at[0] + f.size[0] > rx0 && f.at[1] < ry1 && f.at[1] + f.size[1] > ry0;
    if (!inView) continue;
    let ch = featChar.get(f.type);
    if (ch === undefined) {
      const name = f.type.replace(/_/g, "");
      const prefs = (name.toUpperCase() + FEATURE_POOL).split("");
      ch = prefs.find((c) => c !== "" && FEATURE_POOL.includes(c) && !used.has(c)) ?? "?";
      used.add(ch);
      featChar.set(f.type, ch);
      legendFeat.push([ch, featureInfo(f.type).label.toLowerCase()]);
    }
    for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
      for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) {
        const i = cellI(x, y);
        if (i >= 0 && (!featAt.has(i) || f.blocking)) featAt.set(i, { ch, id: f.id });
      }
  }

  const linkUp = new Set<number>();
  const linkDown = new Set<number>();
  const linkNotes: string[] = [];
  for (const link of resolved?.links ?? []) {
    const label = (id: string): string => opts.levelLabels?.[id] ?? id;
    if (link.fromLevel === lvl.id) {
      for (const c of link.lowerCells) linkUp.add(cellI(c[0], c[1]));
      linkNotes.push(
        `${link.id}: ${link.kind} up to ${label(link.toLevel)} from ${fmtCells(link.lowerCells)}`,
      );
    }
    if (link.toLevel === lvl.id) {
      for (const c of link.upperCells) linkDown.add(cellI(c[0], c[1]));
      linkNotes.push(
        `${link.id}: ${link.kind} down to ${label(link.fromLevel)}, arrive ${link.arrival[0]},${link.arrival[1]}`,
      );
    }
  }

  const deepIdx = lvl.materials.indexOf("water_deep") + 1;
  const lavaIdx = lvl.materials.indexOf("lava") + 1;
  const lowSeen = new Set<number>();
  const highSeen = new Set<number>();
  const baseSeen = new Set<string>();
  const view = (gx: number, gy: number): CellView => {
    const i = cellI(gx, gy);
    if (i < 0) return { base: "", feat: null, featId: null };
    const st = lvl.cells.state[i];
    const fl = lvl.cells.flags[i] as number;
    let base: string;
    if (st === CELL.SOLID) base = "#";
    else if (st === CELL.VOID) base = " ";
    else if (linkUp.has(i) || fl & CELL_FLAG.LINK) base = ">";
    else if (fl & CELL_FLAG.STAIRWELL || linkDown.has(i)) base = "<";
    else if (fl & CELL_FLAG.NO_FLOOR) base = "O";
    else if (fl & CELL_FLAG.BRIDGE) base = "=";
    else if (fl & CELL_FLAG.WATER) base = deepIdx > 0 && lvl.cells.material[i] === deepIdx ? "W" : "~";
    else if (lavaIdx > 0 && lvl.cells.material[i] === lavaIdx) base = "%";
    else if (fl & CELL_FLAG.PATH) base = ",";
    else {
      const q = lvl.cells.height[i] as number;
      // raised floor in half tiles as a digit (tiers read at a glance), other raised heights "^", sunken "_"
      base = q < 0 ? "_" : q > 0 ? (q % 2 === 0 && q <= 18 ? String(q / 2) : "^") : ".";
      if (q < 0) lowSeen.add(q);
      if (q > 0 && base === "^") highSeen.add(q);
    }
    if (gx >= rx0 && gx < rx1 && gy >= ry0 && gy < ry1) baseSeen.add(base);
    const f = featAt.get(i);
    return { base, feat: f && base !== ">" && base !== "<" ? f.ch : null, featId: f ? f.id : null };
  };
  const shown = (v: CellView): string => v.feat ?? v.base;

  const lines: string[] = [];
  // issue markers: "!" on the offending cells inside the view
  const marked = new Set<string>();
  const markNotes: string[] = [];
  for (const is of opts.issues ?? []) {
    if (is.levelId !== lvl.id || !is.cell) continue;
    const [mx, my] = is.cell;
    if (mx < rx0 || mx >= rx1 || my < ry0 || my >= ry1) continue;
    marked.add(`${mx},${my}`);
    markNotes.push(`! ${mx},${my} ${is.severity} ${is.code}${is.elementId ? ` ${is.elementId}` : ""}`);
  }
  const maxW = opts.maxDoubleWidth ?? 60;
  const usedEdgeChars = new Set<string>();
  const seen = { ledge: false, stair: false };

  if (rw > maxW) {
    // 1 char per cell, no walls
    lines.push(header1(rx0, rw));
    for (let gy = ry0; gy < ry1; gy++) {
      let row = "";
      for (let gx = rx0; gx < rx1; gx++) row += marked.has(`${gx},${gy}`) ? "!" : shown(view(gx, gy));
      lines.push(rowLabel(gy) + row);
    }
    lines.push(
      `(level crop is ${rw} cells wide: 1 char per cell, walls and doors omitted; call view_plan ascii with region ≤ ${maxW} wide for walls)`,
    );
  } else {
    const GW = 2 * rw + 1;
    const GH = 2 * rh + 1;
    const g: string[][] = Array.from({ length: GH }, () => new Array<string>(GW).fill(" "));
    const cells: CellView[][] = [];
    for (let y = ry0 - 1; y <= ry1; y++) {
      const row: CellView[] = [];
      for (let x = rx0 - 1; x <= rx1; x++) row.push(view(x, y));
      cells.push(row);
    }
    const cv = (gx: number, gy: number): CellView =>
      (cells[gy - ry0 + 1] as CellView[])[gx - rx0 + 1] as CellView;
    const hEdge = (gx: number, gy: number): { kind: number; ref: number } => {
      const lx = gx - B.x;
      const ly = gy - B.y;
      if (lx < 0 || lx >= B.w || ly < 0 || ly > B.h) return { kind: EDGE.NONE, ref: 0 };
      const i = ly * B.w + lx;
      return { kind: lvl.hEdges.kind[i] as number, ref: lvl.hEdges.ref[i] as number };
    };
    const vEdge = (gx: number, gy: number): { kind: number; ref: number } => {
      const lx = gx - B.x;
      const ly = gy - B.y;
      if (lx < 0 || lx > B.w || ly < 0 || ly >= B.h) return { kind: EDGE.NONE, ref: 0 };
      const i = ly * (B.w + 1) + lx;
      return { kind: lvl.vEdges.kind[i] as number, ref: lvl.vEdges.ref[i] as number };
    };
    const join = (a: CellView, b: CellView): string => {
      if (a.featId !== null && a.featId === b.featId && a.feat !== null) return a.feat;
      if (a.base === "") return b.base === "" ? " " : b.base;
      if (b.base === "") return a.base;
      return a.base === b.base ? a.base : " ";
    };
    const edgeChar = (e: { kind: number; ref: number }, wallCh: string, a: CellView, b: CellView): string => {
      if (e.kind === EDGE.WALL) return wallCh;
      if (e.kind === EDGE.STAIR) {
        seen.stair = true;
        return "/";
      }
      if (e.kind === EDGE.LEDGE) {
        seen.ledge = true;
        return ":";
      }
      if (e.kind === EDGE.OPENING) {
        const o = lvl.openings[e.ref];
        const ch = o ? OPENING_CHAR[o.kind] : "d";
        usedEdgeChars.add(ch);
        return ch;
      }
      return join(a, b);
    };
    for (let gy = ry0; gy < ry1; gy++) {
      for (let gx = rx0; gx < rx1; gx++) {
        const r = 2 * (gy - ry0) + 1;
        const c = 2 * (gx - rx0) + 1;
        (g[r] as string[])[c] = shown(cv(gx, gy));
      }
    }
    // horizontal edges (rows 0,2,..), vertical edges (cols 0,2,..)
    for (let gy = ry0; gy <= ry1; gy++) {
      for (let gx = rx0; gx < rx1; gx++) {
        (g[2 * (gy - ry0)] as string[])[2 * (gx - rx0) + 1] = edgeChar(
          hEdge(gx, gy),
          "-",
          cv(gx, gy - 1),
          cv(gx, gy),
        );
      }
    }
    for (let gy = ry0; gy < ry1; gy++) {
      for (let gx = rx0; gx <= rx1; gx++) {
        (g[2 * (gy - ry0) + 1] as string[])[2 * (gx - rx0)] = edgeChar(
          vEdge(gx, gy),
          "|",
          cv(gx - 1, gy),
          cv(gx, gy),
        );
      }
    }
    // vertices
    const wallish = (k: number): boolean => k === EDGE.WALL || k === EDGE.OPENING;
    for (let gy = ry0; gy <= ry1; gy++) {
      for (let gx = rx0; gx <= rx1; gx++) {
        const hz = wallish(hEdge(gx - 1, gy).kind) || wallish(hEdge(gx, gy).kind);
        const vt = wallish(vEdge(gx, gy - 1).kind) || wallish(vEdge(gx, gy).kind);
        let ch: string;
        if (hz && vt) ch = "+";
        else if (hz) ch = "-";
        else if (vt) ch = "|";
        else {
          const a = cv(gx - 1, gy - 1);
          const b = cv(gx, gy - 1);
          const c = cv(gx - 1, gy);
          const d = cv(gx, gy);
          const ledge =
            hEdge(gx - 1, gy).kind === EDGE.LEDGE ||
            hEdge(gx, gy).kind === EDGE.LEDGE ||
            vEdge(gx, gy - 1).kind === EDGE.LEDGE ||
            vEdge(gx, gy).kind === EDGE.LEDGE;
          const real = [a, b, c, d].filter((v) => v.base !== "");
          const r0 = real[0];
          if (ledge) ch = ":";
          else if (r0 && real.every((v) => v.base === r0.base)) {
            const sameFeat =
              r0.featId !== null && real.length === 4 && real.every((v) => v.featId === r0.featId);
            ch = sameFeat && r0.feat ? r0.feat : r0.base;
          } else ch = " ";
        }
        (g[2 * (gy - ry0)] as string[])[2 * (gx - rx0)] = ch;
      }
    }
    // room keys
    lvl.areas.forEach((a, ai) => {
      if (!a.key || a.cellCount === 0) return;
      const text = `[${a.key}]`;
      const tries: Vec2[] = [a.anchor];
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const)
        tries.push([a.anchor[0] + dx, a.anchor[1] + dy]);
      for (const [ax, ay] of tries) {
        if (ax < rx0 || ax >= rx1 || ay < ry0 || ay >= ry1) continue;
        const r = 2 * (ay - ry0) + 1;
        const c0 = 2 * (ax - rx0);
        const row = g[r] as string[];
        if (c0 + text.length > GW) continue;
        let ok = true;
        for (let k = 0; k < text.length && ok; k++) {
          const col = c0 + k;
          if (col % 2 === 1) {
            const gx = rx0 + (col - 1) / 2;
            const i = cellI(gx, ay);
            const v = cv(gx, ay);
            ok =
              i >= 0 &&
              lvl.cells.area[i] === ai + 1 &&
              v.feat === null &&
              (v.base === "." ||
                v.base === "," ||
                v.base === "~" ||
                v.base === "_" ||
                v.base === "^" ||
                /^[1-9]$/.test(v.base));
          } else {
            ok = vEdge(rx0 + col / 2, ay).kind === EDGE.NONE;
          }
        }
        if (!ok) continue;
        for (let k = 0; k < text.length; k++) row[c0 + k] = text[k] as string;
        break;
      }
    });
    for (const k of marked) {
      const [mx, my] = k.split(",").map(Number) as [number, number];
      (g[2 * (my - ry0) + 1] as string[])[2 * (mx - rx0) + 1] = "!";
    }
    lines.push(header2(rx0, rw));
    g.forEach((row, r) => {
      const gy = ry0 + (r - 1) / 2;
      lines.push((r % 2 === 1 ? rowLabel(gy) : "    ") + row.join("").replace(/\s+$/, ""));
    });
  }

  if (opts.legend ?? true) {
    const parts: string[] = [];
    for (const ch of ["d", "D", "L", "s", "a", "w", "p"])
      if (usedEdgeChars.has(ch)) parts.push(`${ch} ${OPENING_NAME[ch] as string}`);
    if (seen.ledge) parts.push(": ledge/cliff (height step between cells)");
    const fmtH = (qs: Set<number>): string =>
      [...qs]
        .sort((a, b) => a - b)
        .map((q) => (q > 0 ? "+" : "") + String(q / 4))
        .join(" ");
    if (lowSeen.size > 0 && baseSeen.has("_")) parts.push(`_ floor below the level floor (${fmtH(lowSeen)})`);
    const digits = [...baseSeen].filter((c) => /^[1-9]$/.test(c)).sort();
    if (digits.length > 0) parts.push(`${digits.join("")} raised floor in half tiles (1 = +0.5, 2 = +1 …)`);
    if (highSeen.size > 0 && baseSeen.has("^")) parts.push(`^ raised floor (${fmtH(highSeen)})`);
    if (seen.stair) parts.push("/ steps (walkable stair between heights)");
    if (baseSeen.has("%")) parts.push("% lava");
    if (baseSeen.has("~")) parts.push("~ shallow water");
    if (baseSeen.has("W")) parts.push("W deep water");
    if (baseSeen.has("=")) parts.push("= bridge deck");
    if (baseSeen.has("O")) parts.push("O hole / no floor");
    for (const [ch, name] of legendFeat) parts.push(`${ch} ${name}`);
    if (parts.length > 0) lines.push(`legend: ${parts.join(", ")}`);
    for (const n of linkNotes) lines.push(`link ${n}`);
    for (const n of markNotes) lines.push(n);
  }
  return lines.join("\n");
}

function fmtCells(cells: readonly Vec2[]): string {
  return cells.map((c) => `${c[0]},${c[1]}`).join(" ");
}

function rowLabel(gy: number): string {
  return gy % 5 === 0 ? String(gy).padStart(3, " ") + " " : "    ";
}

function header2(rx0: number, rw: number): string {
  const chars = new Array<string>(2 * rw + 1).fill(" ");
  for (let gx = rx0; gx < rx0 + rw; gx++) {
    if (gx % 5 !== 0) continue;
    const s = String(gx);
    const c = 2 * (gx - rx0) + 1;
    for (let k = 0; k < s.length && c + k < chars.length; k++) chars[c + k] = s[k] as string;
  }
  return "    " + chars.join("").replace(/\s+$/, "");
}

function header1(rx0: number, rw: number): string {
  const chars = new Array<string>(rw).fill(" ");
  for (let gx = rx0; gx < rx0 + rw; gx++) {
    if (gx % 10 !== 0) continue;
    const s = String(gx);
    for (let k = 0; k < s.length && gx - rx0 + k < chars.length; k++) chars[gx - rx0 + k] = s[k] as string;
  }
  return "    " + chars.join("").replace(/\s+$/, "");
}
