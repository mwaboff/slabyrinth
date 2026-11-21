/**
 * Verify stage (runs after realize, before chunk): checks the REALIZED tile set — real asset footprints, heights
 * and origins — against the resolved grid, so anything that is fine in the plan but wrong once real assets are
 * placed is caught at conversion. Returns structured diagnostics (stable code, severity, location, elements,
 * assets, plain message, plan-level hint). Safe repairs that do not change the design are applied and reported
 * as info diagnostics with `repaired` set. Never throws for bad content.
 */
import type {
  CompileDiagnostic,
  CompileDiagnosticCode,
  PaletteCatalog,
  Placement,
  PlacementSet,
} from "../../contracts/compiler";
import type { FeatureType, LevelId, MapPlan, PlanIssue, Side } from "../../contracts/plan";
import {
  CELL_FLAG,
  EDGE,
  type ResolvedFeature,
  type ResolvedLevel,
  type ResolvedPlan,
} from "../../contracts/resolved";
import { createRoleResolver } from "../../palette/resolve";
import { generatorProfile } from "../../plan/generator";
import { stallParts } from "../../palette/stallParts";
import { checkPlayability, walkReachability } from "../../resolve";
import { placedBox, placedName } from "../placed";
import type { RealizedSet } from "../realize/output";
import { SolidIndex, overlap1, type Solid } from "./grid";
import { LevelGrid, sideOrient } from "../../resolve/levelGrid";
import { findWallFaces } from "../../resolve/wallFaces";
import { areaReferenceHeights, edgeWallHeight } from "../../resolve/wallspan";
import { structureClaims } from "../structure";
import { featureInfo } from "../../gen/catalog";
import { OPPOSITE as OPP, SIDE_STEP as DIRV, SIDES } from "../../gen/gridGeometry";

export interface VerifyOptions {
  /** Level the party enters on (MapPlan.entryLevel); default: the level with elevation closest to 0. */
  entryLevelId?: LevelId;
  /** Apply safe automatic repairs (default true). */
  repair?: boolean;
  /** Plan-to-world orientation (default flipZ true, as in orientation.json). */
  flipZ?: boolean;
  /**
   * The plan. When given, reachability reuses the resolver's WalkGraph (`walkReachability`) with the realized
   * occupancy as `extraBlocked`, and problems the plan-level playability pass already reports
   * (`checkPlayability`) are not reported a second time under a verify code.
   */
  plan?: MapPlan;
  /** Plan-level issues already reported (default: resolved.issues + checkPlayability(plan) when `plan` is set). */
  planIssues?: PlanIssue[];
}

/** verify code → plan-level code(s) that already describe the same problem for the same element. */
const COVERED_BY_PLAN: Partial<Record<CompileDiagnosticCode, readonly string[]>> = {
  verify_door_blocked: ["opening_blocked"],
  verify_door_leads_nowhere: ["opening_dead_end", "opening_blocked"],
  verify_stairs_approach_blocked: ["link_approach_blocked"],
  verify_stairs_arrival_blocked: ["link_blocked", "link_run_blocked"],
};

export interface VerifyResult {
  diagnostics: CompileDiagnostic[];
  counts: { error: number; warning: number; info: number };
  repairs: number;
  /** Wall-clock time of the stage (ms), for the performance budget. */
  ms: number;
}

/** Feature types that are organic dressing: their overlaps are expected and reported as info only. */
const ORGANIC = new Set<FeatureType>([
  "tree",
  "dead_tree",
  "pine_tree",
  "bush",
  "rock",
  "boulder",
  "stump",
  "log",
  "mushroom",
  "tall_grass",
  "reeds",
  "flowers",
  "rubble",
  "bones",
  "web",
  "debris",
]);
/** Features hung from the ceiling: raised on purpose, never "floating". */
const CEILING_MOUNTED = new Set<string>(["stalactite", "chandelier"]);
/** Opening kinds that are not passages (no standing-room or reachability semantics). */
const NOT_PASSAGE = new Set(["window", "arrow_slit", "bars"]);
const HEAD = 1.5; // clear height a creature needs above a floor top (medium creature with margin)
const STEP = 0.5; // largest height difference walkable without stairs

type Diag = Omit<CompileDiagnostic, "stage">;

export function verifyBuild(
  resolved: ResolvedPlan,
  set: PlacementSet,
  palettes: PaletteCatalog,
  opts: VerifyOptions = {},
): VerifyResult {
  const t0 = Date.now();
  const out: CompileDiagnostic[] = [];
  const add = (d: Diag): void => {
    out.push({ ...d, stage: "verify" });
  };
  const repair = opts.repair ?? true;
  let repairs = 0;
  const hg = resolved.levels.reduce((m, l) => Math.max(m, l.bounds.y + l.bounds.h), 0);
  const index = new SolidIndex(hg, opts.flipZ ?? true);
  const levels = resolved.levels.filter((l) => set.levels.some((s) => s.levelId === l.id));
  const grids = new Map(levels.map((l) => [l.id, new LevelGrid(l)]));
  // edges a building builds itself (compile/structure.ts), and the walls as realize finds them (resolve/wallFaces.ts):
  // the wall check and the wall-style note read the same faces
  const wallsOf = new Map(
    levels.map((l) => {
      const claims = structureClaims(l);
      const faces = findWallFaces(grids.get(l.id) ?? new LevelGrid(l), {
        claimed: claims.edges,
        refHeights: areaReferenceHeights(l),
        boardEdgeIsExit: generatorProfile(resolved).boardEdgeExits,
      });
      return [l.id, { claims, faces }] as const;
    }),
  );
  const featureById = new Map<string, ResolvedFeature>();
  for (const l of levels) for (const f of l.features) featureById.set(`${l.id}|${f.id}`, f);
  const levelOf = new Map(levels.map((l) => [l.id, l]));
  const reportedMissing = new Set(
    set.diagnostics
      .filter((d) => d.code === "role_missing")
      .map((d) => `${d.levelId ?? ""}|${d.elementId ?? ""}|${d.role ?? ""}`),
  );
  const floorRoleMissing = new Set(
    set.diagnostics
      .filter((d) => d.code === "role_missing" && (d.role ?? "").startsWith("floor."))
      .map((d) => d.levelId ?? ""),
  );

  // ── repairs first: bad coordinates (dropped, error) and exact duplicates (dropped, info) ──
  for (const lv of set.levels) {
    const seen = new Set<string>();
    const kept: Placement[] = [];
    const dups = new Map<string, number>();
    for (const p of lv.placements) {
      if (
        ![p.x, p.y, p.z, p.rot].every(Number.isFinite) ||
        Math.abs(p.rot / 15 - Math.round(p.rot / 15)) > 1e-6
      ) {
        add({
          severity: "error",
          code: "verify_bad_coordinate",
          levelId: lv.levelId,
          message: `"${nameOf(p)}" has an invalid position or rotation (${p.x}, ${p.y}, ${p.z}, ${p.rot}°) and was left out of the build.`,
          hint: "This is a compiler bug or a broken palette offset; report it with the plan.",
          assets: [nameOf(p)],
          ...el(p.source.elementId),
          repaired: "placement dropped",
        });
        continue;
      }
      const k = `${p.asset}|${p.x.toFixed(2)}|${p.y.toFixed(2)}|${p.z.toFixed(2)}|${p.rot}`;
      if (seen.has(k)) {
        if (repair) {
          dups.set(nameOf(p), (dups.get(nameOf(p)) ?? 0) + 1);
          repairs++;
          continue;
        }
      }
      seen.add(k);
      kept.push(p);
    }
    for (const [name, n] of dups) {
      add({
        severity: "info",
        code: "verify_duplicate_removed",
        levelId: lv.levelId,
        message: `Removed ${n} exact duplicate${n > 1 ? "s" : ""} of "${name}" (same position and rotation) on level ${lv.levelId}.`,
        assets: [name],
        count: n,
        repaired: `dropped ${n} duplicate placement${n > 1 ? "s" : ""}`,
      });
    }
    lv.placements.splice(0, lv.placements.length, ...kept);
  }

  // ── spatial index of every realized placement ──
  const solidOf = new Map<Placement, Solid>();
  for (const lv of set.levels) {
    for (const p of lv.placements) {
      const f =
        p.role === "feature" ? featureById.get(`${lv.levelId}|${p.source.elementId ?? ""}`) : undefined;
      const meta = set.placed?.get(p);
      const s: Solid = {
        p,
        box: placedBox(set, p),
        levelId: lv.levelId,
        role: p.role,
        name: placedName(set, p),
        blocking: p.role !== "feature" || (f?.blocking ?? true),
        organic: f !== undefined && (ORGANIC.has(f.type) || featureInfo(f.type).organic),
        wallMounted: f?.wall !== undefined,
        isTileFeature: p.role === "feature" && meta?.geom.originAt === "minCorner",
      };
      solidOf.set(p, s);
      index.add(s);
    }
  }
  const structural = (s: Solid): boolean => s.role !== "feature" && s.role !== "marker";
  const wallish = (s: Solid): boolean => s.role === "wall" || s.role === "wall_post" || s.role === "opening";
  /**
   * Generator 3: an overhead line's pieces hang from its anchors, not from the floor. A piece is exempt from the floating
   * test only when its line (ResolvedLevel.lines) holds at both ends: a wall or roof piece at the line's height beside the
   * anchor cell, or a post piece of the line that reaches it. A line that does not hold is reported once
   * (`verify_line_unanchored`) and its pieces still fire `verify_prop_floating`.
   */
  const lineHolds = new Map<string, boolean>();
  const lineHeld = (L: (typeof levels)[number], featureId: string | undefined, y: number): boolean => {
    const lineId = (featureId ?? "").split("#")[0] ?? "";
    const ln = (L.lines ?? []).find((q) => q.id === lineId);
    if (!ln) return false;
    const key = `${L.id}|${ln.id}`;
    const hit = lineHolds.get(key);
    if (hit !== undefined) return hit;
    // the rope's own height (absolute): a hung piece sits lower than the line
    y = L.features.find((f) => f.id.startsWith(`${ln.id}#`) && f.type === "overhead")?.baseHeight ?? y;
    const holds = ln.anchors.every((an) => {
      // the wall stands on the cell's edge, hosted in this cell or the one beside it: look at the cell and its neighbours
      const near = [-1, 0, 1].flatMap((dx) =>
        [-1, 0, 1].flatMap((dy) => index.near(an.at[0] + dx + 0.5, an.at[1] + dy + 0.5)),
      );
      return near.some((q) => {
        if (q.levelId !== L.id) return false;
        if (an.kind === "post")
          return (
            q.role === "feature" &&
            (q.p.source.elementId ?? "").startsWith(`${ln.id}#post`) &&
            q.box.max.y >= y - 0.05
          );
        return (
          q.role !== "floor" &&
          q.role !== "fill" &&
          q.role !== "feature" &&
          q.role !== "link" &&
          q.box.max.y >= y - 0.05 &&
          q.box.min.y <= y + 0.05
        );
      });
    });
    lineHolds.set(key, holds);
    if (!holds)
      add({
        severity: "warning",
        code: "verify_line_unanchored",
        levelId: L.id,
        elementId: ln.id,
        message: `Overhead line "${ln.id}" is not held at both ends: no wall or post reaches its height (${round2(y)}) beside ${fmt(ln.a)} and ${fmt(ln.b)}.`,
        hint: `Raise the posts or end the line against a taller wall, or lower the line's height.`,
      });
    return holds;
  };
  const label = (s: Solid): string =>
    `"${s.name}"${s.p.source.elementId && !s.p.source.elementId.includes(".") && s.p.source.elementId !== "fill" ? ` (${s.p.source.elementId})` : ""}`;

  /** Plan point → world, and the free (unhosted) centre of a cell. */
  const w = (px: number, py: number): { x: number; z: number } => index.toWorld(px, py);
  const freeCentre = (g: LevelGrid, x: number, y: number): { x: number; z: number } | null => {
    let x0 = x,
      x1 = x + 1,
      y0 = y,
      y1 = y + 1;
    if (g.hostedOn(x, y, "W")) x0 += 0.5;
    if (g.hostedOn(x, y, "E")) x1 -= 0.5;
    if (g.hostedOn(x, y, "N")) y0 += 0.5;
    if (g.hostedOn(x, y, "S")) y1 -= 0.5;
    if (x1 - x0 < 0.2 || y1 - y0 < 0.2) return null;
    // an outer corner of a building diagonal to this cell (walls on both neighbours, hosted on this side) carries a
    // corner post in this cell's corner quarter: when that quarter is all that is left free, the cell is not open floor
    const hostedBy = (cx: number, cy: number, side: Side): boolean => g.hostedOn(cx, cy, side);
    const quarter = (qx: number, qy: number): boolean =>
      x0 >= qx - 0.01 && x1 <= qx + 0.51 && y0 >= qy - 0.01 && y1 <= qy + 0.51;
    if (
      (quarter(x + 0.5, y + 0.5) && hostedBy(x + 1, y, "S") && hostedBy(x, y + 1, "E")) ||
      (quarter(x, y + 0.5) && hostedBy(x - 1, y, "S") && hostedBy(x, y + 1, "W")) ||
      (quarter(x + 0.5, y) && hostedBy(x + 1, y, "N") && hostedBy(x, y - 1, "E")) ||
      (quarter(x, y) && hostedBy(x - 1, y, "N") && hostedBy(x, y - 1, "W"))
    )
      return null;
    return w((x0 + x1) / 2, (y0 + y1) / 2);
  };

  // link membership: lower-level run cells
  interface RunCell {
    linkId: string;
    k: number;
    last: boolean;
  }
  const runCells = new Map<string, RunCell>();
  const runIndex = (lk: ResolvedPlan["links"][number], c: readonly [number, number]): number => {
    const xs = lk.lowerCells.map((q) => q[0]);
    const ys = lk.lowerCells.map((q) => q[1]);
    return lk.dir === "N"
      ? Math.max(...ys) - c[1]
      : lk.dir === "S"
        ? c[1] - Math.min(...ys)
        : lk.dir === "E"
          ? c[0] - Math.min(...xs)
          : Math.max(...xs) - c[0];
  };
  for (const lk of resolved.links) {
    if (lk.kind !== "stairs" && lk.kind !== "ramp") continue;
    const ks = lk.lowerCells.map((c) => runIndex(lk, c));
    const maxK = Math.max(...ks);
    lk.lowerCells.forEach((c, i) =>
      runCells.set(`${lk.fromLevel}|${c[0]},${c[1]}`, { linkId: lk.id, k: ks[i] ?? 0, last: ks[i] === maxK }),
    );
  }
  const isRun = (lv: LevelId, x: number, y: number): RunCell | undefined => runCells.get(`${lv}|${x},${y}`);

  // ── (6) structure: floors and walls ──
  const resolveRole = createRoleResolver(palettes);
  for (const L of levels) {
    const g = grids.get(L.id);
    const walls = wallsOf.get(L.id);
    if (!g || !walls) continue;
    let missing = 0;
    let first: [number, number] | null = null;
    let gaps = 0;
    let firstGap: {
      cell: [number, number];
      side: Side;
      style: string;
      blockBetweenOpen: boolean;
      mount: string;
    } | null = null;
    const { claims, faces } = walls;
    for (let ly = 0; ly < g.h; ly++) {
      for (let lx = 0; lx < g.w; lx++) {
        const x = L.bounds.x + lx;
        const y = L.bounds.y + ly;
        const c = g.cell(x, y);
        if (c.floor) {
          const top = g.top(x, y);
          const p = w(x + 0.5, y + 0.5);
          const has = index
            .at(p.x, p.z, top - 0.2, top - 0.05)
            .some(
              (s) =>
                s.levelId === L.id &&
                (s.role === "floor" || s.role === "fill" || s.role === "link" || s.role === "ledge"),
            );
          if (!has) {
            missing++;
            first ??= [x, y];
          }
        }
        // wall edges: north and west edge of every cell, plus south/east borders
        const checks: Array<[Side, number, number]> = [
          ["N", x, y],
          ["W", x, y],
        ];
        if (ly === g.h - 1) checks.push(["S", x, y]);
        if (lx === g.w - 1) checks.push(["E", x, y]);
        for (const [side, cx, cy] of checks) {
          const orient = sideOrient(side);
          const ei = g.edgeIndex(cx, cy, side);
          // the wall as realize builds it (resolve/wallFaces.ts): style, theme, span, and the cell its mass stands in
          const face = faces.at(orient, ei);
          if (!face || face.kind !== EDGE.WALL) continue;
          const hostedHere = face.host.x === cx && face.host.y === cy;
          const { style } = face;
          const [dx, dy] = DIRV[side];
          const other = g.cell(cx + dx, cy + dy);
          const here = g.cell(cx, cy);
          // the theme realize builds the wall in (its mount decides how the wall is measured)
          const res = resolveRole(face.theme, `wall.${style}`).resolution;
          if (!res) continue; // role_missing already reported by realize
          const mount = res.def.mount ?? "half-cell";
          const hgt = edgeWallHeight(g.edges(orient), ei);
          const base = face.base;
          const inside = hostedHere ? other : here; // shells host outside the footprint
          // a building's shell edge (compile/structure.ts) stands on the building's own floor: its storey height is
          // measured from there, not from higher ground outside
          const top = face.claimed
            ? // a ruin's walls only need to stand a tile above its floor (their tops are broken)
              claims.ruined.has(`${orient}${ei}`)
              ? L.elevation + inside.height + 0.5 + 1
              : Math.min(face.top, L.elevation + inside.height + 0.5 + hgt)
            : face.top;
          // a rock block stands in the face's mass cell (realize: compile/realize/walls.ts gatherFullCells); with no
          // mass cell past the board edge (an exit) nothing stands there and the edge is not a gap
          if (mount === "full-cell" && !face.mass && !(face.host.open && face.other.open)) continue;
          const massHere = face.mass !== null && face.mass.x === cx && face.mass.y === cy;
          const intoHere = mount === "full-cell" && face.mass ? massHere : hostedHere;
          // midpoint of the edge in plan coords, then into the host half-cell (a block: into its mass cell)
          const mx = side === "W" ? cx : side === "E" ? cx + 1 : cx + 0.5;
          const my = side === "N" ? cy : side === "S" ? cy + 1 : cy + 0.5;
          const hostSign = intoHere ? 1 : -1; // +1 = into (cx,cy), -1 = into the neighbour
          const inward = mount === "edge-center" ? 0 : mount === "full-cell" ? 0.5 : 0.25;
          const ix = side === "W" ? inward * hostSign : side === "E" ? -inward * hostSign : 0;
          const iy = side === "N" ? inward * hostSign : side === "S" ? -inward * hostSign : 0;
          const pt = w(mx + ix, my + iy);
          // natural (full-cell) rock walls vary in height: at least 1.5 above the floor counts as closed
          const ys =
            mount === "half-cell"
              ? [base + 0.1, top - 0.1]
              : mount === "full-cell"
                ? [base + 0.1, Math.min(top, base + 1.5) - 0.1]
                : [base + 0.1];
          const covered = ys.every((yy) =>
            index
              .at(pt.x, pt.z, yy - 0.01, yy + 0.01, 0.005)
              .some((s) => s.levelId === L.id && (wallish(s) || s.role === "fill")),
          );
          if (!covered) {
            gaps++;
            firstGap ??= {
              cell: [cx, cy],
              side,
              style,
              blockBetweenOpen: mount === "full-cell" && here.open && other.open,
              mount,
            };
          }
        }
      }
    }
    if (missing > 0 && first) {
      const sev = floorRoleMissing.has(L.id) ? "warning" : "error";
      const mat = L.materials[(L.cells.material[g.index(first[0], first[1])] ?? 1) - 1] ?? "?";
      add({
        severity: sev,
        code: "verify_floor_missing",
        levelId: L.id,
        cell: first,
        count: missing,
        message: `${missing} floor cell${missing > 1 ? "s have" : " has"} no floor tile on level ${L.id} (first at ${fmt(first)}, material ${mat}).`,
        hint: `Use a floor material the theme has assets for (e.g. flagstone, wood_plank, rock, grass) instead of "${mat}".`,
      });
    }
    if (gaps > 0 && firstGap) {
      add({
        severity: "error",
        code: "verify_wall_gap",
        levelId: L.id,
        cell: firstGap.cell,
        side: firstGap.side,
        count: gaps,
        message: firstGap.blockBetweenOpen
          ? `${gaps} wall edge${gaps > 1 ? "s" : ""} on level ${L.id} cannot be built: the 2D map shows a ${firstGap.style} wall between two open areas at the ${firstGap.side} side of ${fmt(firstGap.cell)}, but rock-block walls need a solid cell, so the build leaves the gap open.`
          : `${gaps} wall edge${gaps > 1 ? "s are" : " is"} not fully covered by wall pieces on level ${L.id} (first: ${firstGap.side} side of ${fmt(firstGap.cell)}, style ${firstGap.style}).`,
        hint: firstGap.blockBetweenOpen
          ? `Natural rock is built as whole-cell blocks and needs a solid cell: leave one unclaimed (solid) cell between the two areas there, or merge them into one area. A thin built wall (wallStyle "wall") is the only other choice and looks like masonry, not rock.`
          : `The theme has no "${firstGap.style}" wall piece that fits this edge (${firstGap.mount} mount), so the build leaves it open. Use a wallStyle the theme has pieces for (list_catalog wall_styles), or leave a solid cell beside the area so a whole-cell block has somewhere to stand.`,
      });
    }
  }

  // ── (6a) rock-band cliffs: a natural edge of 2 tiles or more whose face realize left to the band (no blocks, no
  // fill behind it) must be covered by band rock, or the void behind it shows ──
  for (const L of levels) {
    const runs = L.cliffs ?? [];
    if (!generatorProfile(resolved).cliffRockBand || runs.length === 0) continue;
    const rocks = L.features.filter((f) => f.type === "cliff_face" || f.type === "cliff_crest");
    const placed = set.levels.find((s) => s.levelId === L.id)?.placements ?? [];
    const blocks = new Set(
      placed
        .filter((p) => p.role === "ledge" && p.source.cell)
        .map((p) => `${p.source.cell?.[0] ?? ""},${p.source.cell?.[1] ?? ""}`),
    );
    let holes = 0;
    let firstHole: [number, number] | null = null;
    for (const run of runs)
      for (const e of run.edges) {
        if (e.high - e.low < 8) continue;
        const lx = e.at[0] - L.bounds.x;
        const ly = e.at[1] - L.bounds.y;
        if (lx <= 0 || ly <= 0 || lx >= L.bounds.w - 1 || ly >= L.bounds.h - 1) continue;
        const theme = L.themes[L.cells.theme[ly * L.bounds.w + lx] ?? 0] ?? "generic";
        if (!resolveRole(theme, "cliff.formation_face").resolution) continue;
        if (blocks.has(`${e.at[0]},${e.at[1]}`)) continue;
        const [dx, dy] = DIRV[e.side];
        const mx = e.at[0] + 0.5 + dx * 0.5;
        const my = e.at[1] + 0.5 + dy * 0.5;
        const covered = rocks.some(
          (f) =>
            mx >= f.at[0] - 0.3 &&
            mx <= f.at[0] + f.size[0] + 0.3 &&
            my >= f.at[1] - 0.3 &&
            my <= f.at[1] + f.size[1] + 0.3,
        );
        if (covered) continue;
        holes++;
        firstHole ??= [e.at[0], e.at[1]];
      }
    if (holes > 0 && firstHole)
      add({
        severity: "warning",
        code: "verify_cliff_gap",
        levelId: L.id,
        cell: firstHole,
        count: holes,
        message: `${holes} cliff edge${holes === 1 ? "" : "s"} on level ${L.id} rise 2 tiles or more with no rock in front and no face behind (first at (${firstHole[0]},${firstHole[1]})): the void under the upper ground shows.`,
        hint: "dress the cliff with its rock band (a dress op over the level), or move what keeps the band off that edge",
      });
  }

  // ── (6a) covered stalls (generator 4) the palettes cannot build: the same question the resolver asked (palette/stallParts.ts) ──
  // The resolver asks it of the LEVEL's theme (resolve/level/market.ts) and this asks the stall's own theme, so it fires
  // when a stall row stands in an area of another theme whose palette lacks a part. It also fires when the resolved plan
  // was resolved against other palettes than the ones compiled with (a caller error: both take the same catalog).
  if (generatorProfile(resolved).coveredStalls)
    for (const L of levels) {
      for (const f of L.features) {
        if (!f.stall) continue;
        const lx = f.at[0] - L.bounds.x;
        const ly = f.at[1] - L.bounds.y;
        const theme = f.theme || (L.themes[L.cells.theme[ly * L.bounds.w + lx] ?? 0] ?? "generic");
        const parts = stallParts((roles, filter) => {
          for (const role of roles) {
            const r = resolveRole(theme, role, filter).resolution;
            if (r) return r;
          }
          return null;
        }, f.stall.form);
        if ("missing" in parts)
          add({
            severity: "warning",
            code: "verify_stall_uncovered",
            levelId: L.id,
            ...el(f.id),
            cell: [f.at[0], f.at[1]],
            message: `Stall ${f.id} was laid out covered (${f.stall.form} canopy, ${f.stall.w}x${f.stall.d}) but theme "${theme}" has no stall ${parts.missing} piece; only its table and goods were built.`,
            hint: `covered stalls are chosen by the level's theme: put the stall row in an area of that theme, or give theme "${theme}" a stall ${parts.missing} piece`,
          });
      }
    }

  // ── (6b) preview fidelity: materials and wall styles the 2D map shows but the theme builds with something else ──
  for (const L of levels) {
    const g = grids.get(L.id);
    if (!g) continue;
    const mats = new Map<string, { theme: string; material: string; n: number; first: [number, number] }>();
    const note = (theme: string, material: string, x: number, y: number): void => {
      const k = `${theme}|${material}`;
      const e = mats.get(k);
      if (e) e.n++;
      else mats.set(k, { theme, material, n: 1, first: [x, y] });
    };
    for (let ly = 0; ly < g.h; ly++)
      for (let lx = 0; lx < g.w; lx++) {
        const i = ly * g.w + lx;
        const c = g.cell(L.bounds.x + lx, L.bounds.y + ly);
        if (!c.floor) continue;
        const m = L.materials[(L.cells.material[i] ?? 1) - 1];
        if (m) note(L.themes[L.cells.theme[i] ?? 0] ?? "generic", m, L.bounds.x + lx, L.bounds.y + ly);
      }
    for (const b of L.bridges ?? [])
      b.cells.forEach((c, j) => {
        const m = b.underMaterial[j];
        const i = g.index(c[0], c[1]);
        if (m && i >= 0) note(L.themes[L.cells.theme[i] ?? 0] ?? "generic", m, c[0], c[1]);
      });
    for (const e of mats.values()) {
      // water is TaleSpire's board water level over a bed (bed.*): no water tile is expected (verify_water_level)
      if (e.material.startsWith("water")) continue;
      const want = `floor.${e.material}`;
      const res = resolveRole(e.theme, want).resolution;
      if (!res || res.role === want) continue;
      const liquid = e.material === "lava" || e.material.startsWith("water");
      const asset = res.variants[0]?.name;
      add({
        severity: liquid ? "warning" : "info",
        code: "verify_material_substituted",
        levelId: L.id,
        cell: e.first,
        count: e.n,
        role: want,
        message: `The 2D map shows ${e.n} cell${e.n > 1 ? "s" : ""} of ${e.material} on level ${L.id}, but theme "${e.theme}" has no ${e.material} tile: ${e.n > 1 ? "they are" : "it is"} built with ${res.role}${asset ? ` ("${asset}")` : ""}${liquid ? ", so in TaleSpire it looks like ordinary floor" : ""}.`,
        hint: liquid
          ? `The palette needs a real ${e.material} asset for ${want}. Until it has one, say so to the GM, or describe the hazard in the notes.`
          : `Use a material the theme has its own tiles for, or accept the look of ${res.role}.`,
      });
    }
    const styles = new Map<string, { theme: string; style: string; n: number }>();
    const faces = wallsOf.get(L.id)?.faces;
    // the theme a wall is built in is its face's; released generators asked the level's first theme for every wall
    const inFaceTheme = generatorProfile(resolved).wallNoteInFaceTheme;
    // in edge index order (h edges, then v edges), which orders the notes; building shells are built from
    // facade.<style> roles (compile/structure.ts), not wall.<style>
    for (const orient of ["h", "v"] as const)
      for (let e = 0; e < g.edges(orient).kind.length; e++) {
        const face = faces?.at(orient, e);
        if (!face || face.kind !== EDGE.WALL || face.claimed) continue;
        const theme = inFaceTheme ? face.theme : (L.themes[0] ?? "generic");
        const k = `${theme}|${face.style}`;
        const x = styles.get(k);
        if (x) x.n++;
        else styles.set(k, { theme, style: face.style, n: 1 });
      }
    for (const st of styles.values()) {
      const want = `wall.${st.style}`;
      const res = resolveRole(st.theme, want).resolution;
      if (!res || res.role === want || st.style === "wall") continue;
      add({
        severity: "info",
        code: "verify_material_substituted",
        levelId: L.id,
        count: st.n,
        role: want,
        message: `Wall style "${st.style}" (${st.n} edges on level ${L.id}) has no pieces of its own in theme "${st.theme}": it is built with ${res.role}${res.variants[0]?.name ? ` ("${res.variants[0].name}")` : ""}.`,
        hint: `Pick a wall style this theme has its own pieces for (list_catalog wall_styles); "${st.style}" looks like ${res.role} here.`,
      });
    }
  }

  // ── (1) preview fidelity: realized solids intruding into cells the 2D map shows as open floor ──
  const obstructed = new Map<string, Solid[]>(); // `${level}|x,y` → blockers
  for (const L of levels) {
    const g = grids.get(L.id);
    if (!g) continue;
    const agg = new Map<string, { n: number; first: [number, number]; s: Solid; cells: number }>();
    for (let ly = 0; ly < g.h; ly++) {
      for (let lx = 0; lx < g.w; lx++) {
        const x = L.bounds.x + lx;
        const y = L.bounds.y + ly;
        const c = g.cell(x, y);
        if (!c.floor || (c.flags & (CELL_FLAG.FEATURE | CELL_FLAG.LINK | CELL_FLAG.STEPS)) !== 0) continue;
        const pc = freeCentre(g, x, y);
        if (!pc) continue;
        const top = g.top(x, y);
        const hits = index.at(pc.x, pc.z, top + STEP, top + HEAD).filter(structural);
        if (!hits.length) continue;
        obstructed.set(`${L.id}|${x},${y}`, hits);
        const s = hits[0] as Solid;
        const k = `${s.name}|${s.p.source.elementId ?? ""}`;
        const a = agg.get(k);
        if (a) a.n++;
        else agg.set(k, { n: 1, first: [x, y], s, cells: 1 });
      }
    }
    for (const a of agg.values()) {
      add({
        severity: "warning",
        code: "verify_cell_obstructed",
        levelId: L.id,
        cell: a.first,
        count: a.n,
        ...el(a.s.p.source.elementId),
        assets: [a.s.name],
        message: `${label(a.s)} fills ${a.n > 1 ? `${a.n} cells` : "a cell"} the 2D map shows as open floor (first at ${fmt(a.first)} on level ${L.id}).`,
        hint: `Keep ${fmt(a.first)} free in the plan (mark it as part of the obstacle), or move the element that places ${a.s.name}.`,
      });
    }
  }

  // ── (2) doors and openings ──
  const blockedOpenings = new Map<string, Solid[]>(); // `${level}|${openingId}` → blockers
  const blockedSides = new Map<string, Set<0 | 1>>(); // `${level}|${openingId}` → blocked sides (0 = N/W cell)
  for (const L of levels) {
    const g = grids.get(L.id);
    if (!g) continue;
    for (const op of L.openings) {
      const passage = !NOT_PASSAGE.has(op.kind);
      const pieces = index.all.filter(
        (s) =>
          s.levelId === L.id && s.p.source.elementId === op.id && (s.role === "opening" || s.role === "wall"),
      );
      const edges: Array<{ a: [number, number]; b: [number, number]; sideOfB: Side }> = [];
      for (let k = 0; k < op.width; k++) {
        if (op.orientation === "h") {
          const x = op.start[0] + k;
          const y = op.start[1];
          edges.push({ a: [x, y - 1], b: [x, y], sideOfB: "N" });
        } else {
          const x = op.start[0];
          const y = op.start[1] + k;
          edges.push({ a: [x - 1, y], b: [x, y], sideOfB: "W" });
        }
      }
      if (op.kind !== "open" && pieces.length === 0) {
        const known = [...reportedMissing].some((k) => k.startsWith(`${L.id}|${op.id}|`));
        if (!known) {
          add({
            severity: "error",
            code: "verify_door_missing",
            levelId: L.id,
            elementId: op.id,
            cell: edges[0]?.b ?? [op.start[0], op.start[1]],
            side: edges[0]?.sideOfB ?? "N",
            message: `Opening ${op.id} (${op.kind}) has no door or arch piece in the build.`,
            hint: `Change opening ${op.id} to a kind the theme has assets for (door, double_door, archway width 2) or to "open".`,
          });
        }
      }
      // pieces in the host half-cell, and not buried by wall pieces
      for (const s of pieces.filter((q) => q.role === "opening")) {
        const ok = edges.some((e) => {
          const host = g.hostedOn(e.b[0], e.b[1], e.sideOfB) ? e.b : e.a;
          const sideInHost: Side = host === e.b ? e.sideOfB : OPP[e.sideOfB];
          const r = halfCellRect(host, sideInHost);
          const p0 = w(r.x0, r.y1);
          const p1 = w(r.x1, r.y0);
          const zx0 = Math.min(p0.x, p1.x) - 0.06,
            zx1 = Math.max(p0.x, p1.x) + 0.06;
          const zz0 = Math.min(p0.z, p1.z) - 0.06,
            zz1 = Math.max(p0.z, p1.z) + 0.06;
          const inX = overlap1(s.box.min.x, s.box.max.x, zx0, zx1) > 0.2;
          const inZ =
            s.box.min.z >= zz0 - (op.width > 1 ? 1 : 0) && s.box.max.z <= zz1 + (op.width > 1 ? 1 : 0);
          const inX2 =
            s.box.min.x >= zx0 - (op.width > 1 ? 1 : 0) && s.box.max.x <= zx1 + (op.width > 1 ? 1 : 0);
          return inX && inZ && inX2;
        });
        if (!ok) {
          add({
            severity: "error",
            code: "verify_door_misplaced",
            levelId: L.id,
            elementId: op.id,
            cell: edges[0]?.b ?? [0, 0],
            side: edges[0]?.sideOfB ?? "N",
            assets: [s.name],
            message: `The ${s.name} for opening ${op.id} is not inside its wall's half-cell.`,
            hint: "Check the palette geometry (size, originAt, lengthAxis) of this door asset.",
          });
        }
        const buried = index
          .near(...planOf(s))
          .filter((q) => q !== s && q.levelId === L.id && q.role === "wall" && q.p.source.elementId !== op.id)
          .filter(
            (q) =>
              overlap1(q.box.min.x, q.box.max.x, s.box.min.x, s.box.max.x) > 0.1 &&
              overlap1(q.box.min.z, q.box.max.z, s.box.min.z, s.box.max.z) > 0.1 &&
              overlap1(q.box.min.y, q.box.max.y, s.box.min.y, s.box.max.y) > 0.2,
          );
        if (buried.length) {
          add({
            severity: "error",
            code: "verify_door_buried",
            levelId: L.id,
            elementId: op.id,
            assets: [s.name, ...uniq(buried.map((b) => b.name))],
            message: `Opening ${op.id}: its ${s.name} overlaps ${buried[0]?.name ?? "a wall piece"}, so the doorway is walled up.`,
            hint: `Remove the wall run crossing opening ${op.id} or move the opening; if neither applies, check the palette geometry of ${s.name}.`,
          });
        }
      }
      if (!passage) continue;
      let nowhere = false;
      const blockers: Solid[] = [];
      let blockedCell: [number, number] | null = null;
      for (const e of edges) {
        for (const [cell, sideTowardEdge] of [
          [e.a, OPP[e.sideOfB]],
          [e.b, e.sideOfB],
        ] as Array<[[number, number], Side]>) {
          const c = g.cell(cell[0], cell[1]);
          if (!c.open) {
            nowhere = true;
            continue;
          }
          if (!c.floor) {
            add({
              severity: "error",
              code: "verify_door_no_floor",
              levelId: L.id,
              elementId: op.id,
              cell,
              message: `Opening ${op.id} opens onto ${fmt(cell)}, which has no floor (hole or stairwell).`,
              hint: `Move opening ${op.id} so both sides have floor, or give ${fmt(cell)} a floor.`,
            });
            continue;
          }
          const hosted = g.hostedOn(cell[0], cell[1], sideTowardEdge);
          const d = hosted ? 0.75 : 0.25;
          const mx =
            sideTowardEdge === "W" ? cell[0] + d : sideTowardEdge === "E" ? cell[0] + 1 - d : cell[0] + 0.5;
          const my =
            sideTowardEdge === "N" ? cell[1] + d : sideTowardEdge === "S" ? cell[1] + 1 - d : cell[1] + 0.5;
          const pt = w(mx, my);
          const top = g.top(cell[0], cell[1]);
          const hits = index
            .at(pt.x, pt.z, top + STEP, top + HEAD)
            .filter((s) => s.levelId === L.id && s.p.source.elementId !== op.id && s.blocking);
          if (hits.length) {
            blockers.push(...hits);
            blockedCell ??= cell;
            const sides = blockedSides.get(`${L.id}|${op.id}`) ?? new Set<0 | 1>();
            sides.add(cell === e.a ? 0 : 1);
            blockedSides.set(`${L.id}|${op.id}`, sides);
          }
        }
      }
      if (nowhere) {
        add({
          severity: "warning",
          code: "verify_door_leads_nowhere",
          levelId: L.id,
          elementId: op.id,
          cell: edges[0]?.b ?? [0, 0],
          side: edges[0]?.sideOfB ?? "N",
          message: `Opening ${op.id} leads into solid rock or empty space on one side, so nobody can come through it.`,
          hint: `Connect opening ${op.id} to an area on both sides (e.g. add a corridor behind it), use between: [area, "@outside"] only where the outside is open ground, or remove it.`,
        });
      }
      if (blockers.length && blockedCell) {
        blockedOpenings.set(`${L.id}|${op.id}`, blockers);
        const b = blockers[0] as Solid;
        const alt = suggestDoorCell(L, g, op, index, w);
        add({
          severity: "error",
          code: "verify_door_blocked",
          levelId: L.id,
          elementId: op.id,
          elementIds: uniq([
            op.id,
            ...blockers
              .map((q) => q.p.source.elementId ?? "")
              .filter((x) => x && !x.includes(".") && x !== "fill"),
          ]),
          cell: blockedCell,
          assets: uniq(blockers.map((q) => q.name)),
          message: `Opening ${op.id} cannot be used: ${label(b)} fills the space in front of it at ${fmt(blockedCell)} on level ${L.id}.`,
          hint: alt
            ? `Move opening ${op.id} to ${alt} (clear on both sides), or move ${b.p.source.elementId ?? b.name} so ${fmt(blockedCell)} stays free.`
            : `Move opening ${op.id} along the wall away from ${b.p.source.elementId ?? b.name}, or move that element so ${fmt(blockedCell)} stays free.`,
        });
      }
    }
  }

  // ── (4) stairs and links ──
  const linkOk = new Map<string, boolean>();
  // why a link does not work (first reason), for the "area cannot be reached" error: names the link and the fix
  const linkWhy = new Map<string, { why: string; fix: string }>();
  const whyLink = (id: string, why: string, fix: string): void => {
    if (!linkWhy.has(id)) linkWhy.set(id, { why, fix });
  };
  for (const lk of resolved.links) {
    const lower = levelOf.get(lk.fromLevel);
    const upper = levelOf.get(lk.toLevel);
    const gl = grids.get(lk.fromLevel);
    const gu = grids.get(lk.toLevel);
    if (!lower || !upper || !gl || !gu) continue;
    let ok = true;
    if (lk.kind === "stairs" || lk.kind === "ramp") {
      const parts = index.all.filter((s) => s.levelId === lower.id && s.p.source.elementId === lk.id);
      const last = lk.lowerCells.filter((c) => isRun(lower.id, c[0], c[1])?.last);
      const [dx, dy] = DIRV[lk.dir];
      for (const c of last) {
        const arr: [number, number] = [c[0] + dx, c[1] + dy];
        const upTop = gu.top(arr[0], arr[1]);
        const pc = w(c[0] + 0.5, c[1] + 0.5);
        const runTop = Math.max(
          -Infinity,
          ...parts
            .filter(
              (s) => s.box.min.x < pc.x && s.box.max.x > pc.x && s.box.min.z < pc.z && s.box.max.z > pc.z,
            )
            .map((s) => s.box.max.y),
        );
        if (!Number.isFinite(runTop) || Math.abs(runTop - upTop) > 0.3) {
          ok = false;
          whyLink(
            lk.id,
            Number.isFinite(runTop)
              ? `its top step is at height ${round2(runTop)} but the floor it should meet on ${upper.id} is at ${round2(upTop)}`
              : `it has no step or landing at ${fmt(c)}`,
            `check the elevations of ${lower.id} and ${upper.id} (one storey = 2.5) and that the theme has a stairs asset`,
          );
          add({
            severity: "error",
            code: "verify_stairs_no_arrival",
            levelId: lower.id,
            elementId: lk.id,
            cell: c,
            message: Number.isFinite(runTop)
              ? `Stairs ${lk.id} end at height ${round2(runTop)} but the floor they lead to on level ${upper.id} is at ${round2(upTop)}.`
              : `Stairs ${lk.id} have no step or landing at ${fmt(c)}.`,
            hint: `Check the elevations of ${lower.id} and ${upper.id} (one storey = 2.5) and that link ${lk.id} has a stairs asset in its theme.`,
          });
        }
        const ac = gu.cell(arr[0], arr[1]);
        const wallBetween = gu.wallOn(c[0], c[1], lk.dir);
        const arrHits = ac.floor ? obstructed.get(`${upper.id}|${arr[0]},${arr[1]}`) : undefined;
        if (!ac.open || !ac.floor || wallBetween || arrHits) {
          ok = false;
          whyLink(
            lk.id,
            `it lands at ${fmt(arr)} on ${upper.id}, which ${!ac.open ? "is solid rock or void" : !ac.floor ? "has no floor (a hole or the stair well itself)" : wallBetween ? "is behind a wall" : `is filled by ${arrHits?.[0]?.name ?? "a solid"}`}`,
            `make ${fmt(arr)} open floor of an area on ${upper.id} (the run climbs from ${fmt(lk.lowerCells[0] ?? c)} in direction ${lk.dir} and lands one cell past its last step), or change from.at or dir`,
          );
          add({
            severity: "error",
            code: "verify_stairs_arrival_blocked",
            levelId: upper.id,
            elementId: lk.id,
            cell: arr,
            ...(arrHits ? { assets: uniq(arrHits.map((s) => s.name)) } : {}),
            message: `Stairs ${lk.id} arrive at ${fmt(arr)} on level ${upper.id}, which ${!ac.open || !ac.floor ? "has no floor" : wallBetween ? "is behind a wall" : `is filled by ${arrHits?.[0]?.name ?? "a solid"}`}.`,
            hint: `Make ${fmt(arr)} open floor of an area on ${upper.id} with no wall toward the stairs, or turn link ${lk.id}.`,
          });
        }
      }
      // generator 4: every step of the run, not only the last: each cell's top stands above the one behind it by no
      // more than a step (1 tile), so no gap or drop breaks the climb (a missing piece, a step of another height)
      if (generatorProfile(resolved).everyStepVerified) {
        const topAt = (c: readonly [number, number]): number => {
          const pc = w(c[0] + 0.5, c[1] + 0.5);
          return Math.max(
            -Infinity,
            ...parts
              .filter(
                (s) => s.box.min.x < pc.x && s.box.max.x > pc.x && s.box.min.z < pc.z && s.box.max.z > pc.z,
              )
              .map((s) => s.box.max.y),
          );
        };
        const MAX_STEP = 1.05;
        let bad: { c: readonly [number, number]; text: string } | undefined;
        for (const c of lk.lowerCells) {
          const run = isRun(lower.id, c[0], c[1]);
          if (!run) continue;
          const top = topAt(c);
          const behindCell: [number, number] = [c[0] - dx, c[1] - dy];
          const behindRun = isRun(lower.id, behindCell[0], behindCell[1]);
          const behind =
            behindRun?.linkId === lk.id
              ? topAt(behindCell)
              : run.k === 0
                ? gl.top(behindCell[0], behindCell[1])
                : -Infinity;
          if (!Number.isFinite(top)) {
            bad = {
              c,
              text: `step ${run.k + 1} of ${lk.lowerCells.length} at ${fmt(c)} has no piece, so the climb has a gap`,
            };
            break;
          }
          if (Number.isFinite(behind) && (top - behind > MAX_STEP || top - behind < 0.05)) {
            bad = {
              c,
              text: `step ${run.k + 1} of ${lk.lowerCells.length} at ${fmt(c)} stands at height ${round2(top)}, ${round2(top - behind)} from the one behind it (${round2(behind)})`,
            };
            break;
          }
        }
        if (bad) {
          ok = false;
          whyLink(
            lk.id,
            `its climb is broken: ${bad.text}`,
            `check that link ${lk.id} has a stairs asset in its theme and that the run of ${lk.lowerCells.length} cells fits the rise of ${lk.rise}`,
          );
          add({
            severity: "error",
            code: "verify_stairs_no_arrival",
            levelId: lower.id,
            elementId: lk.id,
            cell: [bad.c[0], bad.c[1]],
            message: `Stairs ${lk.id} do not climb all the way: ${bad.text}.`,
            hint: `Check that link ${lk.id} has a stairs asset in its theme and that the run of ${lk.lowerCells.length} cells fits the rise of ${lk.rise}.`,
          });
        }
      }
      for (const c of lk.lowerCells.filter((q) => isRun(lower.id, q[0], q[1])?.k === 0)) {
        const ap: [number, number] = [c[0] - dx, c[1] - dy];
        const a = gl.cell(ap[0], ap[1]);
        const wall = gl.wallOn(c[0], c[1], OPP[lk.dir]);
        const hits = obstructed.get(`${lower.id}|${ap[0]},${ap[1]}`);
        const featureThere = (a.flags & CELL_FLAG.FEATURE) !== 0;
        if (
          !a.open ||
          !a.floor ||
          wall ||
          hits ||
          featureThere ||
          Math.abs(gl.top(ap[0], ap[1]) - gl.top(c[0], c[1])) > STEP
        ) {
          ok = false;
          whyLink(
            lk.id,
            `nobody can step onto its first step at ${fmt(c)} on ${lower.id}: the cell before it, ${fmt(ap)}, ${!a.open ? "is solid rock or void" : !a.floor ? "has no floor" : wall ? "is behind a wall" : featureThere ? "holds a feature" : hits ? `is filled by ${hits[0]?.name ?? "a solid"}` : "is at a different height"}`,
            `the run starts at from.at ${fmt(lk.lowerCells[0] ?? c)} and climbs in direction ${lk.dir}, so the walkway must reach the foot from the opposite side (${fmt(ap)}); move from.at to the other end of the corridor and flip dir, or lengthen the area behind the foot`,
          );
          add({
            severity: "error",
            code: "verify_stairs_approach_blocked",
            levelId: lower.id,
            elementId: lk.id,
            cell: ap,
            ...(hits ? { assets: uniq(hits.map((s) => s.name)) } : {}),
            message: `Nobody can step onto the bottom of stairs ${lk.id}: the cell before it, ${fmt(ap)}, ${!a.open || !a.floor ? "has no floor" : wall ? "is behind a wall" : featureThere ? "holds a feature" : hits ? `is filled by ${hits[0]?.name ?? "a solid"}` : "is at a different height"}.`,
            hint: `Move link ${lk.id} so the cell before its first step (opposite its dir ${lk.dir}) is open floor in the same area.`,
          });
        }
      }
    }
    // vertical links: the stack must reach the upper floor top (ladder, spiral stairs or their fallback)
    if (lk.kind === "ladder" || lk.kind === "spiral_stairs") {
      const parts = index.all.filter((s) => s.levelId === lower.id && s.p.source.elementId === lk.id);
      const known = [...reportedMissing].some(
        (k) => k.startsWith(`${lower.id}|`) && k.endsWith(`|link.${lk.kind}`),
      );
      if (parts.length === 0) {
        if (!known) {
          ok = false;
          add({
            severity: "error",
            code: "verify_link_short",
            levelId: lower.id,
            elementId: lk.id,
            cell: lk.lowerCells[0] ?? lk.arrival,
            message: `Link ${lk.id} (${lk.kind}) has no pieces in the build, so nothing connects ${lower.id} to ${upper.id}.`,
            hint: `Use kind "stairs" or "ladder" for link ${lk.id}; this theme has no asset for ${lk.kind}.`,
          });
        } else ok = false;
      } else {
        const top = Math.max(...parts.map((s) => s.box.max.y));
        const cell = parts[0]?.p.source.cell ?? lk.lowerCells[0] ?? lk.arrival;
        const upTop = gu.top(cell[0], cell[1]);
        if (top < upTop - 0.25) {
          ok = false;
          whyLink(
            lk.id,
            `its ${lk.kind} reaches height ${round2(top)}, short of the floor of ${upper.id} at ${round2(upTop)}`,
            `check the level elevations (a ladder spans one storey, 2.5) or use stairs`,
          );
          add({
            severity: "error",
            code: "verify_link_short",
            levelId: lower.id,
            elementId: lk.id,
            cell,
            assets: uniq(parts.map((s) => s.name)),
            message: `${parts[0]?.name ?? "The link"} for ${lk.id} reaches height ${round2(top)}, short of the floor of ${upper.id} at ${round2(upTop)}.`,
            hint: `Check the elevations of ${lower.id} and ${upper.id} and the height of the ${lk.kind} asset in the palette.`,
          });
        }
      }
    }
    if (lk.kind === "trapdoor") {
      const hatch = index.all.filter((s) => s.levelId === upper.id && s.p.source.elementId === lk.id);
      const cell = lk.upperCells[0] ?? lk.arrival;
      const upTop = gu.top(cell[0], cell[1]);
      if (!hatch.length || Math.abs(Math.min(...hatch.map((s) => s.box.min.y)) - upTop) > 0.3) {
        ok = false;
        add({
          severity: "error",
          code: "verify_link_short",
          levelId: upper.id,
          elementId: lk.id,
          cell,
          message: hatch.length
            ? `The hatch of trapdoor ${lk.id} is not on the floor of ${upper.id} at ${fmt(cell)}.`
            : `Trapdoor ${lk.id} has no hatch piece in the build.`,
          hint: `Give trapdoor ${lk.id} a floored cell on ${upper.id}, or use a theme with a link.trapdoor asset.`,
        });
      }
    } else {
      // every other link needs an open shaft on the upper level (stairwell / ladder hole / pit)
      for (const c of lk.upperCells) {
        const uc = gu.cell(c[0], c[1]);
        const pc = w(c[0] + 0.5, c[1] + 0.5);
        const floorsAbove = index
          .at(pc.x, pc.z, upper.elevation - 0.01, upper.elevation + 0.6)
          .filter((s) => s.levelId === upper.id && (s.role === "floor" || s.role === "fill"));
        if (uc.floor || floorsAbove.length) {
          ok = false;
          whyLink(
            lk.id,
            `the floor of ${upper.id} closes its opening at ${fmt(c)}`,
            `leave ${fmt(c)} without floor on ${upper.id}`,
          );
          add({
            severity: "error",
            code: "verify_stairwell_closed",
            levelId: upper.id,
            elementId: lk.id,
            cell: c,
            message: `The floor of level ${upper.id} closes the opening of ${lk.id} (${lk.kind}) at ${fmt(c)}: there is no way through.`,
            hint: `Leave ${fmt(c)} without floor on ${upper.id} (it should be cut automatically; check overlapping areas there).`,
          });
          break;
        }
      }
    }
    linkOk.set(lk.id, ok);
  }
  /** One-line description of a link, with the ends spelled out: "stairs "a" (from l2 (9,26) climbing N to l1)". */
  const linkWords = (lk: (typeof resolved.links)[number]): string => {
    const f = lk.lowerCells[0];
    const run =
      lk.kind === "stairs" || lk.kind === "ramp"
        ? ` climbing ${lk.dir} to ${lk.toLevel}, landing at ${fmt(lk.arrival)}`
        : ` up to ${lk.toLevel}`;
    return `${lk.kind.replace("_", " ")} "${lk.id}" (from ${lk.fromLevel} ${f ? fmt([f[0], f[1]]) : ""}${run})`;
  };
  /** The broken link a player on level `target` would have had to use: first failing link on the way from the entry. */
  const brokenLinkFor = (target: LevelId): { text: string; fix: string } | undefined => {
    const entry =
      opts.entryLevelId ??
      opts.plan?.entryLevel ??
      [...levels].sort((a, b) => b.elevation - a.elevation)[0]?.id;
    if (!entry || entry === target) return undefined;
    const prev = new Map<LevelId, { from: LevelId; link: (typeof resolved.links)[number] }>();
    const q: LevelId[] = [entry];
    const seen = new Set<LevelId>([entry]);
    while (q.length) {
      const cur = q.shift() as LevelId;
      for (const lk of resolved.links) {
        const nxt = lk.fromLevel === cur ? lk.toLevel : lk.toLevel === cur ? lk.fromLevel : undefined;
        if (nxt === undefined || seen.has(nxt)) continue;
        seen.add(nxt);
        prev.set(nxt, { from: cur, link: lk });
        q.push(nxt);
      }
    }
    const path: Array<(typeof resolved.links)[number]> = [];
    for (let at: LevelId | undefined = target; at !== undefined && prev.has(at); at = prev.get(at)?.from)
      path.unshift((prev.get(at) as { link: (typeof resolved.links)[number] }).link);
    const bad =
      path.find((lk) => linkOk.get(lk.id) === false) ??
      resolved.links.find((lk) => linkOk.get(lk.id) === false);
    if (!bad) return undefined;
    const w = linkWhy.get(bad.id);
    return {
      text: `the way there is ${linkWords(bad)}, which does not work${w ? `: ${w.why}` : ""}`,
      fix: w?.fix ?? `check link ${bad.id}`,
    };
  };

  // lowest piece of each feature: the other pieces of an assembly stand on it
  const assemblyBase = new Map<string, number>();
  for (const s0 of index.all) {
    if (s0.role !== "feature") continue;
    const k = `${s0.levelId}|${s0.p.source.elementId ?? ""}`;
    assemblyBase.set(k, Math.min(assemblyBase.get(k) ?? Infinity, s0.p.y));
  }

  // ── (5) placement of items ──
  for (const L of levels) {
    const g = grids.get(L.id);
    if (!g) continue;
    const props = index.all.filter((s) => s.levelId === L.id && s.role === "feature");
    // overlaps (pairs counted once)
    let pairs = 0;
    let builtPairs = 0;
    const examples: string[] = [];
    const seenPair = new Set<string>();
    for (const a of props) {
      if (!a.blocking && !a.organic) continue;
      for (const b of index.overlapping(a.box)) {
        if (b === a || b.role !== "feature" || b.levelId !== L.id || (!b.blocking && !b.organic)) continue;
        const ida = a.p.source.elementId ?? "";
        const idb = b.p.source.elementId ?? "";
        const key = ida < idb ? `${ida}|${idb}` : `${idb}|${ida}`;
        if (seenPair.has(key) || a.p.source.elementId === b.p.source.elementId) continue;
        const ox = overlap1(a.box.min.x, a.box.max.x, b.box.min.x, b.box.max.x);
        const oz = overlap1(a.box.min.z, a.box.max.z, b.box.min.z, b.box.max.z);
        const oy = overlap1(a.box.min.y, a.box.max.y, b.box.min.y, b.box.max.y);
        const areaA = (a.box.max.x - a.box.min.x) * (a.box.max.z - a.box.min.z);
        const areaB = (b.box.max.x - b.box.min.x) * (b.box.max.z - b.box.min.z);
        if (oy > 0.05 && ox * oz > 0.25 * Math.min(areaA, areaB) && ox * oz > 0.01) {
          seenPair.add(key);
          pairs++;
          // natural pieces (tree canopies, rock piles) overhang what stands beside them by design: only two built
          // pieces overlapping is a warning
          if (!a.organic && !b.organic) builtPairs++;
          if (examples.length < 3) examples.push(`${label(a)} and ${label(b)}`);
        }
      }
    }
    if (pairs > 0) {
      add({
        severity: builtPairs > 0 ? "warning" : "info",
        code: "verify_props_overlap",
        levelId: L.id,
        count: pairs,
        message: `${pairs} pair${pairs > 1 ? "s" : ""} of props overlap on level ${L.id} (e.g. ${examples.join("; ")}); TaleSpire can silently drop overlapping props when pasting.`,
        hint: "Space these features at least one cell apart (scatter: raise minSpacing).",
      });
    }
    for (const s of props) {
      const f = featureById.get(`${L.id}|${s.p.source.elementId ?? ""}`);
      // generator 3: the rock band skirts the board's edge from the base plane, partly outside the level and over no floor
      // by design (cliffband.ts checks every piece rests on something)
      if (
        generatorProfile(resolved).restingCliffBand &&
        (f?.type === "cliff_face" || f?.type === "cliff_crest")
      )
        continue;
      const cx = (s.box.min.x + s.box.max.x) / 2;
      const cz = (s.box.min.z + s.box.max.z) / 2;
      const pc = index.toPlan(cx, cz);
      if (!g.cell(Math.floor(pc.px), Math.floor(pc.py)).inBounds) {
        add({
          severity: "warning",
          code: "verify_prop_outside",
          levelId: L.id,
          ...el(s.p.source.elementId),
          assets: [s.name],
          message: `${label(s)} sits outside the bounds of level ${L.id}.`,
          hint: `Move feature ${s.p.source.elementId ?? ""} inside the level bounds.`,
        });
        continue;
      }
      if (s.wallMounted && f?.wall) {
        const kind = g.edgeKind(f.at[0], f.at[1], f.wall);
        const backing = index
          .near(pc.px, pc.py)
          .concat(
            index.near(f.at[0], f.at[1]),
            index.near(f.at[0] + DIRV[f.wall][0], f.at[1] + DIRV[f.wall][1]),
          )
          .some(
            (q) =>
              q.levelId === L.id &&
              wallish(q) &&
              boxDist(q, s.p.x, s.p.z) < 0.6 &&
              overlap1(q.box.min.y, q.box.max.y, s.box.min.y, s.box.max.y) > 0,
          );
        if ((kind !== EDGE.WALL && kind !== EDGE.OPENING) || !backing) {
          add({
            severity: "warning",
            code: "verify_mount_no_wall",
            levelId: L.id,
            ...el(s.p.source.elementId),
            cell: [f.at[0], f.at[1]],
            side: f.wall,
            assets: [s.name],
            message: `${label(s)} is wall-mounted on the ${f.wall} side of ${fmt([f.at[0], f.at[1]])}, but there is no wall piece there.`,
            hint: `Set wall of feature ${s.p.source.elementId ?? ""} to a side of its cell that has a wall.`,
          });
        }
        continue;
      }
      // prop/wall penetration → nudge (repair) or warning
      // organic dressing (rocks, mushrooms, trees) at random 15° turns may clip a corner into rock walls: harmless
      if (!s.isTileFeature && !s.organic) {
        const walls = index
          .overlapping(s.box)
          .filter(
            (q) =>
              q.levelId === L.id &&
              wallish(q) &&
              overlap1(q.box.min.y, q.box.max.y, s.box.min.y, s.box.max.y) > 0.1,
          );
        for (const q of walls) {
          const ox = overlap1(q.box.min.x, q.box.max.x, s.box.min.x, s.box.max.x);
          const oz = overlap1(q.box.min.z, q.box.max.z, s.box.min.z, s.box.max.z);
          if (ox <= 0.03 || oz <= 0.03) continue;
          const alongX = ox < oz;
          const pen = (alongX ? ox : oz) + 0.01;
          const qc = alongX ? (q.box.min.x + q.box.max.x) / 2 : (q.box.min.z + q.box.max.z) / 2;
          const sc = alongX ? cx : cz;
          const dir = sc >= qc ? 1 : -1;
          const fp = f ? footprintWorld(f, w) : null;
          const fits =
            fp !== null &&
            pen <= 0.5 &&
            (alongX
              ? s.box.min.x + dir * pen >= fp.x0 - 0.1 && s.box.max.x + dir * pen <= fp.x1 + 0.1
              : s.box.min.z + dir * pen >= fp.z0 - 0.1 && s.box.max.z + dir * pen <= fp.z1 + 0.1);
          if (repair && fits) {
            index.remove(s);
            if (alongX) {
              s.p.x = round4(s.p.x + dir * pen);
              s.box = {
                min: { ...s.box.min, x: s.box.min.x + dir * pen },
                max: { ...s.box.max, x: s.box.max.x + dir * pen },
              };
            } else {
              s.p.z = round4(s.p.z + dir * pen);
              s.box = {
                min: { ...s.box.min, z: s.box.min.z + dir * pen },
                max: { ...s.box.max, z: s.box.max.z + dir * pen },
              };
            }
            const known = set.placed?.get(s.p);
            if (known) known.box = s.box;
            index.add(s);
            repairs++;
            const compass = alongX ? (dir > 0 ? "east" : "west") : dir > 0 ? "north" : "south";
            add({
              severity: "info",
              code: "verify_prop_nudged",
              levelId: L.id,
              ...el(s.p.source.elementId),
              assets: [s.name, q.name],
              message: `${label(s)} poked ${round2(pen - 0.01)} tiles into ${q.name}; it was moved ${round2(pen)} tiles ${compass}.`,
              repaired: `moved ${s.name} ${round2(pen)} tiles ${compass}`,
            });
          } else {
            add({
              severity: "warning",
              code: "verify_prop_in_wall",
              levelId: L.id,
              ...el(s.p.source.elementId),
              assets: [s.name, q.name],
              message: `${label(s)} is ${round2(pen - 0.01)} tiles inside ${q.name}; it is too big for its cell next to that wall.`,
              hint: `Move feature ${s.p.source.elementId ?? ""} one cell away from the wall, or use a smaller variant.`,
            });
          }
          break;
        }
      }
      // support under the prop
      const supports = index
        .at(cx, cz, -Infinity, s.p.y + 0.06, -0.01)
        .filter(
          (q) =>
            q !== s &&
            q.levelId === L.id &&
            (q.role === "floor" ||
              q.role === "fill" ||
              q.role === "ledge" ||
              q.role === "link" ||
              q.role === "feature") &&
            q.box.max.y <= s.p.y + 0.06,
        );
      const support = supports.length ? Math.max(...supports.map((q) => q.box.max.y)) : null;
      const inside = index
        .at(cx, cz, s.p.y + 0.06, s.p.y + 0.07, 0)
        .filter(
          (q) => q.levelId === L.id && (q.role === "floor" || q.role === "fill") && q.box.min.y < s.p.y,
        );
      if (inside.length) {
        add({
          severity: "warning",
          code: "verify_prop_sunk",
          levelId: L.id,
          ...el(s.p.source.elementId),
          assets: [s.name],
          message: `${label(s)} is sunk into the floor (${inside[0]?.name ?? "floor"}) at ${fmt([Math.floor(pc.px), Math.floor(pc.py)])}.`,
          hint: `Move feature ${s.p.source.elementId ?? ""} fully onto one floor height, or give it a lift equal to the higher floor.`,
        });
      } else if (support === null) {
        add({
          severity: "warning",
          code: "verify_prop_no_floor",
          levelId: L.id,
          ...el(s.p.source.elementId),
          assets: [s.name],
          message: `${label(s)} has nothing under it at ${fmt([Math.floor(pc.px), Math.floor(pc.py)])}.`,
          hint: `Move feature ${s.p.source.elementId ?? ""} onto a cell with floor.`,
        });
      } else if (
        s.p.y - support > 0.3 &&
        // an upper piece of an assembly (palette parts: trunk on stump, capital on shaft) stands on its lower piece
        !(s.p.y > (assemblyBase.get(`${L.id}|${s.p.source.elementId ?? ""}`) ?? Infinity) + 0.01) &&
        !CEILING_MOUNTED.has(featureById.get(`${L.id}|${s.p.source.elementId ?? ""}`)?.type ?? "") &&
        !(
          featureById.get(`${L.id}|${s.p.source.elementId ?? ""}`)?.type === "overhead" &&
          lineHeld(L, s.p.source.elementId, s.p.y)
        )
      ) {
        add({
          severity: "warning",
          code: "verify_prop_floating",
          levelId: L.id,
          ...el(s.p.source.elementId),
          assets: [s.name],
          message: `${label(s)} floats ${round2(s.p.y - support)} tiles above what is under it.`,
          hint: `Reduce the lift of feature ${s.p.source.elementId ?? ""}, or place it on a supporting feature (e.g. a table).`,
        });
      }
    }
  }

  // ── (6b) anything rising through the floor of the level above ──
  const byElev = [...levels].sort((a, b) => a.elevation - b.elevation);
  byElev.forEach((L, i) => {
    const U = byElev[i + 1];
    const gu = U ? grids.get(U.id) : undefined;
    if (!U || !gu) return;
    const hits: Solid[] = [];
    for (const s of index.all) {
      if (s.levelId !== L.id || s.role === "link" || s.box.max.y <= U.elevation + 0.05) continue;
      const pc = index.toPlan((s.box.min.x + s.box.max.x) / 2, (s.box.min.z + s.box.max.z) / 2);
      if (gu.cell(Math.floor(pc.px), Math.floor(pc.py)).floor) hits.push(s);
    }
    if (hits.length) {
      add({
        severity: "warning",
        code: "verify_pokes_into_level_above",
        levelId: L.id,
        count: hits.length,
        assets: uniq(hits.map((s) => s.name)).slice(0, 5),
        ...el(hits[0]?.p.source.elementId),
        message: `${hits.length} piece${hits.length > 1 ? "s" : ""} on level ${L.id} rise through the floor of level ${U.id} (e.g. ${label(hits[0] as Solid)}).`,
        hint: (() => {
          const gap = U.elevation - L.elevation;
          const top = Math.max(...hits.map((s) => s.box.max.y));
          const poke = round2(top - U.elevation);
          const by = new Map<string, { n: number; h: number }>();
          for (const s of hits) {
            const k = s.p.source.elementId?.split(".")[0]?.split("#")[0] || s.name;
            const e = by.get(k) ?? { n: 0, h: 0 };
            e.n++;
            e.h = Math.max(e.h, s.box.max.y - U.elevation);
            by.set(k, e);
          }
          const worst = [...by.entries()]
            .sort((a, b) => b[1].h - a[1].h)
            .slice(0, 3)
            .map(([k, e]) => `${k} (${e.n} piece${e.n > 1 ? "s" : ""}, up to ${round2(e.h)} through)`)
            .join(", ");
          return `The tallest piece reaches ${round2(top - L.elevation)} above level ${L.id}'s base, ${poke} past the underside of ${U.id}'s floor (${U.id} is only ${round2(gap)} above ${L.id}): ${worst}. Choices: raise ${U.id} by at least ${round2(poke)} (a storey of walls needs ${round2(2 + 0.5 + 1)} or more: 2-tall walls, 0.5 floor, 1 of air), or, if it is a platform or feature (not the walls), lower that element or move it out from under ${U.id}'s floor.`;
        })(),
      });
    }
  });

  // ── (3) movement: reachability from the entry, plan-only vs realized ──
  if (opts.plan) {
    // Reuse the resolver's WalkGraph: same rules as plan-level playability, plus what only the build knows.
    const extraBlocked: Record<LevelId, number[]> = {};
    for (const k of obstructed.keys()) {
      const [lv, xy] = k.split("|") as [string, string];
      const [x, y] = xy.split(",").map(Number) as [number, number];
      const g = grids.get(lv);
      const i = g ? g.index(x, y) : -1;
      if (i >= 0) (extraBlocked[lv] ??= []).push(i);
    }
    for (const lk of resolved.links) {
      if (linkOk.get(lk.id) !== false) continue; // stairs that do not arrive: their arrival cells cannot be reached by them
      const g = grids.get(lk.toLevel);
      const [dx, dy] = DIRV[lk.dir];
      for (const c of lk.lowerCells.filter((q) => isRun(lk.fromLevel, q[0], q[1])?.last)) {
        const i = g ? g.index(c[0] + dx, c[1] + dy) : -1;
        if (i >= 0) (extraBlocked[lk.toLevel] ??= []).push(i);
      }
    }
    const extraBlockedOpenings: Record<LevelId, Array<{ openingId: string; side: 0 | 1 | "both" }>> = {};
    for (const [k, sides] of blockedSides) {
      const [lv, id] = k.split("|") as [string, string];
      (extraBlockedOpenings[lv] ??= []).push({
        openingId: id,
        side: sides.size > 1 ? "both" : ([...sides][0] ?? "both"),
      });
    }
    const base = walkReachability(opts.plan, resolved, {}, { secret: true });
    const real = walkReachability(
      opts.plan,
      resolved,
      { extraBlocked, extraBlockedOpenings },
      { secret: true },
    );
    for (const L of levels) {
      const bm = base.get(L.id);
      const rm = real.get(L.id);
      if (!bm || !rm) continue;
      for (const area of L.areas) {
        if (area.kind === "zone") continue;
        const ai = L.areaIds.indexOf(area.id) + 1;
        let inBase = false;
        let inReal = false;
        for (let i = 0; i < L.cells.area.length; i++) {
          if (L.cells.area[i] !== ai) continue;
          if (bm[i]) inBase = true;
          if (rm[i]) inReal = true;
        }
        if (!inBase || inReal) continue;
        // blockers: realized obstructions / blocked doors on cells the plan reaches but the build does not
        const culprits: Array<{ cell: [number, number]; solids: Solid[] }> = [];
        for (const [k, solids] of [...obstructed, ...blockedOpenings]) {
          const [lv, rest] = k.split("|") as [string, string];
          const g = grids.get(lv);
          if (!g) continue;
          if (rest.includes(",")) {
            const [x, y] = rest.split(",").map(Number) as [number, number];
            const i = g.index(x, y);
            if (i >= 0 && base.get(lv)?.[i] && !real.get(lv)?.[i]) culprits.push({ cell: [x, y], solids });
          } else {
            const op = levelOf.get(lv)?.openings.find((o) => o.id === rest);
            if (op) culprits.push({ cell: [op.start[0], op.start[1]], solids });
          }
        }
        const c = culprits[0];
        const b = c?.solids[0];
        const viaLink = b ? undefined : brokenLinkFor(L.id);
        add({
          severity: "error",
          code: "verify_area_unreachable",
          levelId: L.id,
          elementId: area.id,
          elementIds: uniq(
            [area.id, ...(c?.solids.map((s) => s.p.source.elementId ?? "") ?? [])].filter(
              (x) => x && !x.includes(".") && x !== "fill",
            ),
          ),
          ...(c ? { cell: c.cell, assets: uniq(c.solids.map((s) => s.name)) } : {}),
          message: b
            ? `${area.name ?? area.id} on level ${L.id} cannot be reached once the build is placed: ${label(b)} blocks the way at ${fmt(c.cell)}.`
            : viaLink
              ? `${area.name ?? area.id} on level ${L.id} cannot be reached once the build is placed: ${viaLink.text}.`
              : `${area.name ?? area.id} on level ${L.id} cannot be reached once the build is placed, although the plan connects it (no link on the way to it is broken: check the openings leading to it).`,
          hint: b
            ? `Move ${b.p.source.elementId ?? b.name} or the opening it blocks, or add a second opening into ${area.id}.`
            : viaLink
              ? `${viaLink.fix.charAt(0).toUpperCase()}${viaLink.fix.slice(1)}.`
              : `Check the openings leading to ${area.id}; add another opening.`,
        });
      }
    }
  } else {
    reachability(resolved, levels, grids, obstructed, blockedOpenings, linkOk, isRun, add, opts.entryLevelId);
  }

  // problems the plan-level playability pass already reports are not repeated under a verify code
  const planIssues =
    opts.planIssues ??
    (opts.plan ? [...resolved.issues, ...safePlayability(opts.plan, resolved)] : resolved.issues);
  const planKeys = new Set(planIssues.map((i) => `${i.code}|${i.elementId ?? ""}`));
  const covered = (d: CompileDiagnostic): boolean =>
    (COVERED_BY_PLAN[d.code] ?? []).some((c) => planKeys.has(`${c}|${d.elementId ?? ""}`));
  for (let i = out.length - 1; i >= 0; i--) {
    const d = out[i];
    if (d && covered(d)) out.splice(i, 1);
  }

  // stats after repairs
  const byRole = { ...set.stats.byRole };
  for (const k of Object.keys(byRole) as Array<keyof typeof byRole>) byRole[k] = 0;
  let total = 0;
  const assets = new Set<string>();
  for (const lv of set.levels)
    for (const p of lv.placements) {
      byRole[p.role]++;
      total++;
      assets.add(p.asset);
    }
  set.stats = { byRole, total, distinctAssets: assets.size };

  const rank = { error: 0, warning: 1, info: 2 } as const;
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of out) counts[d.severity]++;
  return { diagnostics: out, counts, repairs, ms: Date.now() - t0 };

  function nameOf(p: Placement): string {
    return placedName(set, p);
  }
  function planOf(s: Solid): [number, number] {
    const pc = index.toPlan((s.box.min.x + s.box.max.x) / 2, (s.box.min.z + s.box.max.z) / 2);
    return [pc.px, pc.py];
  }
}

function reachability(
  resolved: ResolvedPlan,
  levels: ResolvedLevel[],
  grids: Map<LevelId, LevelGrid>,
  obstructed: Map<string, Solid[]>,
  blockedOpenings: Map<string, Solid[]>,
  linkOk: Map<string, boolean>,
  isRun: (lv: LevelId, x: number, y: number) => { linkId: string; k: number; last: boolean } | undefined,
  add: (d: Diag) => void,
  entryLevelId: LevelId | undefined,
): void {
  if (!levels.length) return;
  const entry =
    levels.find((l) => l.id === entryLevelId) ??
    [...levels].sort((a, b) => Math.abs(a.elevation) - Math.abs(b.elevation))[0];
  if (!entry) return;
  const openingAt = new Map<string, { id: string; kind: string }>(); // `${level}|x,y|side` (cell b side) → opening
  for (const L of levels)
    for (const op of L.openings)
      for (let k = 0; k < op.width; k++) {
        const x = op.orientation === "h" ? op.start[0] + k : op.start[0];
        const y = op.orientation === "h" ? op.start[1] : op.start[1] + k;
        const side: Side = op.orientation === "h" ? "N" : "W";
        openingAt.set(`${L.id}|${x},${y}|${side}`, { id: op.id, kind: op.kind });
        const [dx, dy] = DIRV[side];
        openingAt.set(`${L.id}|${x + dx},${y + dy}|${OPP[side]}`, { id: op.id, kind: op.kind });
      }
  const jumps = new Map<string, Array<{ to: string; link: string }>>();
  const addJump = (a: string, b: string, link: string, both = true): void => {
    (jumps.get(a) ?? jumps.set(a, []).get(a) ?? []).push({ to: b, link });
    if (both) (jumps.get(b) ?? jumps.set(b, []).get(b) ?? []).push({ to: a, link });
  };
  for (const lk of resolved.links) {
    if (lk.kind === "stairs" || lk.kind === "ramp") {
      const [dx, dy] = DIRV[lk.dir];
      for (const c of lk.lowerCells) {
        if (isRun(lk.fromLevel, c[0], c[1])?.last)
          addJump(`${lk.fromLevel}|${c[0]},${c[1]}`, `${lk.toLevel}|${c[0] + dx},${c[1] + dy}`, lk.id);
      }
    } else if (lk.kind === "pit_drop") {
      lk.upperCells.forEach((c, i) => {
        const lo = lk.lowerCells[i] ?? c;
        addJump(`${lk.toLevel}|${c[0]},${c[1]}`, `${lk.fromLevel}|${lo[0]},${lo[1]}`, lk.id, false);
      });
    } else {
      lk.lowerCells.forEach((c, i) => {
        const up = lk.upperCells[i] ?? lk.arrival;
        addJump(`${lk.fromLevel}|${c[0]},${c[1]}`, `${lk.toLevel}|${up[0]},${up[1]}`, lk.id);
      });
    }
  }
  const rejected: Array<{ cell: string; solids: Solid[] }> = [];

  const run = (realized: boolean): Map<string, number> => {
    const dist = new Map<string, number>();
    const q: string[] = [];
    let head = 0;
    const walkable = (lv: LevelId, x: number, y: number): boolean => {
      const g = grids.get(lv);
      if (!g) return false;
      const c = g.cell(x, y);
      if (!c.open || !c.floor || (c.flags & CELL_FLAG.FEATURE) !== 0) return false;
      if (realized && obstructed.has(`${lv}|${x},${y}`)) return false;
      return true;
    };
    const g0 = grids.get(entry.id);
    if (!g0) return dist;
    // start: the largest area on the entry level
    const counts = new Map<number, number>();
    for (let i = 0; i < entry.cells.area.length; i++) {
      const a = entry.cells.area[i] ?? 0;
      if (a > 0) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    const startArea = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    for (let ly = 0; ly < g0.h; ly++)
      for (let lx = 0; lx < g0.w; lx++) {
        const x = entry.bounds.x + lx;
        const y = entry.bounds.y + ly;
        if ((startArea === undefined || g0.cell(x, y).area === startArea) && walkable(entry.id, x, y)) {
          const k = `${entry.id}|${x},${y}`;
          dist.set(k, 0);
          q.push(k);
        }
      }
    while (head < q.length) {
      const k = q[head++] as string;
      const d = dist.get(k) ?? 0;
      const [lv, xy] = k.split("|") as [string, string];
      const [x, y] = xy.split(",").map(Number) as [number, number];
      const g = grids.get(lv);
      if (!g) continue;
      const run0 = isRun(lv, x, y);
      for (const side of SIDES) {
        const [dx, dy] = DIRV[side];
        const nx = x + dx;
        const ny = y + dy;
        const nk = `${lv}|${nx},${ny}`;
        if (dist.has(nk)) continue;
        const kind = g.edgeKind(x, y, side);
        if (kind === EDGE.WALL) continue;
        if (kind === EDGE.OPENING) {
          const op = openingAt.get(`${lv}|${x},${y}|${side}`);
          if (op && NOT_PASSAGE.has(op.kind)) continue;
          if (realized && op && blockedOpenings.has(`${lv}|${op.id}`)) {
            rejected.push({ cell: nk, solids: blockedOpenings.get(`${lv}|${op.id}`) ?? [] });
            continue;
          }
        }
        const runN = isRun(lv, nx, ny);
        // inside a stair run you move along the run; lateral entry only at the bottom step
        if (run0 && run0.k > 0 && !(runN && runN.linkId === run0.linkId)) continue;
        if (runN && runN.k > 0 && !(run0 && run0.linkId === runN.linkId)) continue;
        if (!walkable(lv, nx, ny)) {
          if (realized && obstructed.has(nk)) rejected.push({ cell: nk, solids: obstructed.get(nk) ?? [] });
          continue;
        }
        if (!(run0 && runN) && Math.abs(g.top(x, y) - g.top(nx, ny)) > STEP + 1e-6) continue;
        dist.set(nk, d + 1);
        q.push(nk);
      }
      for (const j of jumps.get(k) ?? []) {
        if (dist.has(j.to)) continue;
        if (realized && linkOk.get(j.link) === false) continue;
        const [tl, txy] = j.to.split("|") as [string, string];
        const [tx, ty] = txy.split(",").map(Number) as [number, number];
        const tg = grids.get(tl);
        if (!tg) continue;
        const c = tg.cell(tx, ty);
        if (!c.open) continue;
        if (!c.floor && !isRun(tl, tx, ty)) continue;
        if (realized && obstructed.has(j.to)) continue;
        dist.set(j.to, d + 1);
        q.push(j.to);
      }
    }
    return dist;
  };

  const plan = run(false);
  const real = run(true);
  for (const L of levels) {
    for (const area of L.areas) {
      if (area.kind === "zone") continue;
      const ai = L.areaIds.indexOf(area.id) + 1;
      const cells: string[] = [];
      for (let i = 0; i < L.cells.area.length; i++) {
        if (L.cells.area[i] !== ai) continue;
        const x = L.bounds.x + (i % L.bounds.w);
        const y = L.bounds.y + Math.floor(i / L.bounds.w);
        cells.push(`${L.id}|${x},${y}`);
      }
      if (!cells.some((c) => plan.has(c)) || cells.some((c) => real.has(c))) continue;
      // the first rejected step that the plan-level path would have taken
      const cand = rejected
        .filter((r) => plan.has(r.cell) && !real.has(r.cell))
        .sort((a, b) => (plan.get(a.cell) ?? 0) - (plan.get(b.cell) ?? 0))[0];
      const at = cand ? (cand.cell.split("|")[1] ?? "").split(",").map(Number) : null;
      const b = cand?.solids[0];
      add({
        severity: "error",
        code: "verify_area_unreachable",
        levelId: L.id,
        elementId: area.id,
        elementIds: uniq(
          [area.id, ...(cand?.solids.map((s) => s.p.source.elementId ?? "") ?? [])].filter(
            (x) => x && !x.includes(".") && x !== "fill",
          ),
        ),
        ...(at && at.length === 2 ? { cell: [at[0] ?? 0, at[1] ?? 0] as const } : {}),
        ...(cand ? { assets: uniq(cand.solids.map((s) => s.name)) } : {}),
        message: b
          ? `${area.name ?? area.id} on level ${L.id} cannot be reached once the build is placed: "${b.name}"${b.p.source.elementId && !b.p.source.elementId.includes(".") ? ` (${b.p.source.elementId})` : ""} blocks the way at ${cand.cell.split("|")[1] ?? "?"}.`
          : `${area.name ?? area.id} on level ${L.id} cannot be reached once the build is placed, although the plan connects it.`,
        hint: b
          ? `Move ${b.p.source.elementId ?? b.name} or the opening it blocks, or add a second opening into ${area.id}.`
          : `Check the stairs and openings leading to ${area.id}; add another opening.`,
      });
    }
  }
}

function safePlayability(plan: MapPlan, resolved: ResolvedPlan): PlanIssue[] {
  try {
    return checkPlayability(plan, resolved);
  } catch {
    return [];
  }
}

/** A clear edge along the same wall for a blocked opening (hint only). */
function suggestDoorCell(
  L: ResolvedLevel,
  g: LevelGrid,
  op: ResolvedLevel["openings"][number],
  index: SolidIndex,
  w: (px: number, py: number) => { x: number; z: number },
): string | null {
  for (let d = 1; d <= 4; d++) {
    for (const s of [d, -d]) {
      const x = op.orientation === "h" ? op.start[0] + s : op.start[0];
      const y = op.orientation === "h" ? op.start[1] : op.start[1] + s;
      const side: Side = op.orientation === "h" ? "N" : "W";
      if (!g.wallOn(x, y, side)) continue;
      const [dx, dy] = DIRV[side];
      const cells: Array<[number, number, Side]> = [
        [x, y, side],
        [x + dx, y + dy, OPP[side]],
      ];
      const ok = cells.every(([cx, cy]) => {
        const c = g.cell(cx, cy);
        if (!c.open) return true;
        if (!c.floor || (c.flags & (CELL_FLAG.FEATURE | CELL_FLAG.LINK)) !== 0) return false;
        const pc = w(cx + 0.5, cy + 0.5);
        const top = g.top(cx, cy);

        return (
          index
            .at(pc.x, pc.z, top + STEP, top + HEAD)
            .filter((q) => q.levelId === L.id && q.blocking && q.role !== "wall" && q.role !== "wall_post")
            .length === 0
        );
      });
      if (ok) {
        const cellA: [number, number] = g.cell(x, y).open ? [x, y] : [x + dx, y + dy];
        const sideA: Side = g.cell(x, y).open ? side : OPP[side];
        return `at: {x: ${cellA[0]}, y: ${cellA[1]}, side: "${sideA}"}`;
      }
    }
  }
  return null;
}

function halfCellRect(
  cell: readonly [number, number],
  side: Side,
): { x0: number; x1: number; y0: number; y1: number } {
  const [x, y] = cell;
  switch (side) {
    case "N":
      return { x0: x, x1: x + 1, y0: y, y1: y + 0.5 };
    case "S":
      return { x0: x, x1: x + 1, y0: y + 0.5, y1: y + 1 };
    case "W":
      return { x0: x, x1: x + 0.5, y0: y, y1: y + 1 };
    default:
      return { x0: x + 0.5, x1: x + 1, y0: y, y1: y + 1 };
  }
}

function footprintWorld(
  f: ResolvedFeature,
  w: (px: number, py: number) => { x: number; z: number },
): { x0: number; x1: number; z0: number; z1: number } {
  const a = w(f.at[0], f.at[1]);
  const b = w(f.at[0] + f.size[0], f.at[1] + f.size[1]);
  return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z) };
}

function boxDist(s: Solid, x: number, z: number): number {
  const dx = Math.max(s.box.min.x - x, 0, x - s.box.max.x);
  const dz = Math.max(s.box.min.z - z, 0, z - s.box.max.z);
  return Math.hypot(dx, dz);
}

function el(id: string | undefined): { elementId?: string } {
  return id && !id.includes(".") && id !== "fill" && !id.startsWith("post:") ? { elementId: id } : {};
}
const fmt = (c: readonly [number, number]): string => `(${c[0]},${c[1]})`;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;
function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

export const VERIFY_CODES: readonly CompileDiagnosticCode[] = [
  "verify_cell_obstructed",
  "verify_door_blocked",
  "verify_door_no_floor",
  "verify_door_missing",
  "verify_door_misplaced",
  "verify_door_buried",
  "verify_door_leads_nowhere",
  "verify_area_unreachable",
  "verify_stairs_no_arrival",
  "verify_stairs_approach_blocked",
  "verify_stairs_arrival_blocked",
  "verify_stairwell_closed",
  "verify_link_short",
  "verify_props_overlap",
  "verify_prop_in_wall",
  "verify_prop_nudged",
  "verify_prop_floating",
  "verify_prop_sunk",
  "verify_prop_no_floor",
  "verify_mount_no_wall",
  "verify_prop_outside",
  "verify_floor_missing",
  "verify_wall_gap",
  "verify_duplicate_removed",
  "verify_bad_coordinate",
  "verify_pokes_into_level_above",
  "verify_material_substituted",
  "verify_water_level",
];

export type { RealizedSet };
