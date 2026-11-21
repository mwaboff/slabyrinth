/**
 * Realize: ResolvedPlan + palettes + orientation → PlacementSet (architecture §4.3). World space: x east, y up,
 * z north, tiles. Never throws for bad content; problems become aggregated diagnostics.
 */
import type {
  Box3,
  CompileDiagnostic,
  PaletteCatalog,
  Placement,
  PlacementRole,
  RoleName,
} from "../contracts/compiler";
import type { Side, ThemeId } from "../contracts/plan";
import { stallPieceOf } from "../gen/market";
import { featureRoles } from "../gen/surfaces";
import { CELL, CELL_FLAG, EDGE, type ResolvedFeature, type ResolvedLevel, type ResolvedPlan } from "../contracts/resolved";
import { footprintFromGeom, type ResolvedVariant, type VariantFilter } from "../palette/resolve";
import { emptyBox, growBox, h32, placementBox, rotateDir, rotateXZ } from "./geometry";
import { areaReferenceHeights, wallSpan } from "../resolve/wallspan";
import { realizeStructures, structureClaims } from "./structure";
import { realizeStall } from "./stalls";
import { SHELL, planShell } from "./shell";
import { ValueNoise } from "../gen/noise";
import { planCaveWall, type WallFace, type WallShape } from "../gen/cavewall";
import { roughCells } from "../resolve/wallTops";
import { cliffKinds, nearCliff, planRockBand, toneBoulders } from "./realize/cliffBand";
import { createRealizeCtx, type PlacementMeta, type RealizeOptions } from "./realize/context";
import { layPiers, layRaisedFill, stackFill } from "./realize/fill";
import { layFloors, layGroundUnderDecks, layLiquidGlow, layRoadMarkings, layWaterBeds } from "./realize/floors";
import { finishLevel, finishRealize, type RealizedSet, type RealizeOutput } from "./realize/output";
import { EPS, LevelWork, NATURAL_GROUND, opposite } from "./realize/work";

/** World AABB of every placement made by realize (keyed by object; used by chunking for exact bounds). */
export const placementBoxes = new WeakMap<Placement, Box3>();

/** Asset name and geometry of every placement made by realize (used by the verify stage). */
export const placementMeta = new WeakMap<Placement, PlacementMeta>();

const NONE = 0xffff;
/** Opening roles whose asset is a full-height wall piece (no lintel above them). */
const NO_LINTEL = new Set(["opening.archway", "opening.window", "opening.arrow_slit"]);
/** Upright feature types whose assets are mixed along a run (see runPicks). */
const RUN_MIX = new Set([
  "cluster_tall",
  "formation",
  "boulder",
  "tree",
  "pine_tree",
  "dead_tree",
  "stalagmite",
  "edge_dressing",
  "undergrowth",
  "standing_stone",
  "monolith",
  "vehicle",
]);

/** Natural standing pieces that must never be built from wall blocks (generator 3). */
/** Loose rock that follows the tone of a cliff beside it (generator 3). */
const CLIFF_DRESSING = new Set(["formation", "rock_formation", "boulder", "rock"]);
const NATURAL_STANDING =new Set(["cluster_tall", "formation", "landmark", "rock_formation", "tall_marker"]);

/** One edge strip (a wall or door piece occupying the half-cell next to an edge), for corner posts. */
interface Strip {
  orient: "h" | "v";
  /** Plan side of the edge line the strip lies on: h → "N"|"S", v → "W"|"E". */
  side: Side;
  style: string;
  theme: ThemeId;
  base: number;
  top: number;
}

export function realize(
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  opts: RealizeOptions = {},
): RealizedSet {
  const ctx = createRealizeCtx(resolved, palettes, opts, { placementBoxes, placementMeta });
  const { orientation, seed, frame, gen, defaultTheme, addDiag, views, lookup, pick, facingOf } = ctx;
  const levelsWanted = opts.levels ? new Set(opts.levels) : null;
  const out: RealizeOutput = { levels: [], levelInfo: [], allBox: emptyBox() };

  for (const L of resolved.levels) {
    if (levelsWanted && !levelsWanted.has(L.id)) continue;
    const w = new LevelWork(ctx, L);
    const { V, placements, runPicks, levelBox, elev } = w;
    const { blockTurn, topOf, emit } = w;
    let kerbNoted = false;

    planRockBand(w);
    layFloors(w);
    layRoadMarkings(w);
    layWaterBeds(w);
    layGroundUnderDecks(w);
    layRaisedFill(w);
    layPiers(w);
    layLiquidGlow(w);

    // ── 3. walls, openings, posts ──
    const strips = new Map<string, Array<Strip & { dir: Side }>>(); // vertex key → strips ending there
    const addStrip = (vx: number, vy: number, s: Strip, dir: Side): void => {
      const k = `${vx},${vy}`;
      const arr = strips.get(k) ?? [];
      arr.push({ ...s, dir });
      strips.set(k, arr);
    };
    /** Registers a 1-long strip on the edge starting at vertex (vx,vy) running +x (h) or +y (v). */
    const registerEdgeStrip = (orient: "h" | "v", vx: number, vy: number, s: Strip): void => {
      if (orient === "h") {
        addStrip(vx, vy, s, "E");
        addStrip(vx + 1, vy, s, "W");
      } else {
        addStrip(vx, vy, s, "S");
        addStrip(vx, vy + 1, s, "N");
      }
    };

    interface EdgeCtx {
      orient: "h" | "v";
      x: number;
      y: number;
      hostFirst: boolean;
      hostX: number;
      hostY: number;
      /** The cell on the other side of the edge (full-cell blocks go there when the host cell is open). */
      otherX: number;
      otherY: number;
      otherOpen: boolean;
      planSide: Side;
      base: number;
      top: number;
      theme: ThemeId;
      hostOpen: boolean;
    }
    const refHeights = areaReferenceHeights(L);
    /** Edge (x,y) = north edge of cell (x,y) for h, west edge for v. */
    const edgeCtx = (
      orient: "h" | "v",
      x: number,
      y: number,
      grid: ResolvedLevel["hEdges"],
      e: number,
      wallHeight: number,
    ): EdgeCtx => {
      const a = orient === "h" ? V.cell(x, y - 1) : V.cell(x - 1, y);
      const b = V.cell(x, y);
      const hostFirst = (grid.host[e] ?? 1) === 0;
      const host = hostFirst ? a : b;
      const other = hostFirst ? b : a;
      const { base, top } = wallSpan(elev, a, b, hostFirst, wallHeight, refHeights);
      const theme = (other.open ? other.theme : host.open ? host.theme : other.theme) || defaultTheme;
      const hostX = orient === "h" ? x : hostFirst ? x - 1 : x;
      const hostY = orient === "h" ? (hostFirst ? y - 1 : y) : y;
      const otherX = orient === "h" ? x : hostFirst ? x : x - 1;
      const otherY = orient === "h" ? (hostFirst ? y : y - 1) : y;
      const planSide: Side = orient === "h" ? (hostFirst ? "S" : "N") : hostFirst ? "E" : "W";
      return {
        orient,
        x,
        y,
        hostFirst,
        hostX,
        hostY,
        otherX,
        otherY,
        otherOpen: other.open,
        planSide,
        base,
        top,
        theme,
        hostOpen: host.open,
      };
    };

    const lengthOf = (v: ResolvedVariant): number =>
      v.geom.lengthAxis === "square" || v.geom.lengthAxis === undefined
        ? Math.max(1, Math.round(Math.max(v.geom.size.x, v.geom.size.z)))
        : Math.max(1, Math.round(v.geom.lengthAxis === "x" ? v.geom.size.x : v.geom.size.z));
    const lenFilter = (n: number): VariantFilter => ({ key: `len${n}`, test: (v) => lengthOf(v) === n });

    /** Places one half-cell edge piece covering `len` edges starting at the run's first edge ctx. */
    const placeEdgePiece = (
      v: ResolvedVariant,
      role: PlacementRole,
      roleName: RoleName,
      first: EdgeCtx,
      len: number,
      yBase: number,
      count: number,
      source: Placement["source"],
      isDoor: boolean,
    ): void => {
      // host cell whose world min corner anchors the piece: west-most (h run) or south-most in world (v run)
      const hx = first.hostX;
      const hy = first.orient === "v" && frame.o.flipZ ? first.hostY + len - 1 : first.hostY;
      const ws = frame.worldSide(first.planSide);
      const ep = frame.o.edgePlacement[ws];
      const m = frame.rectMin(hx, hy, 1, 1);
      const axisFix = v.geom.lengthAxis === "z" ? 6 : 0;
      let steps = (ep.rotSteps[0] + axisFix) % 24;
      if (isDoor) {
        const f = facingOf(v, "opening", roleName);
        if (f.handleEnd) {
          const pref = frame.o.doorHandlePreference;
          const want: Side =
            ws === "N" || ws === "S" ? (pref?.eastWestEdge ?? "W") : (pref?.northSouthEdge ?? "N");
          const cand = ep.rotSteps.map((r) => (r + axisFix) % 24);
          steps = cand.find((r) => frame.dirAfter(f.handleEnd ?? "W", r) === want) ?? cand[0] ?? steps;
        }
      }
      const unit = v.unitHeight;
      for (let k = 0; k < count; k++) {
        emit(v, role, m.x + ep.offset.x, yBase + k * unit, m.z + ep.offset.z, steps * 15 + v.rot, source);
      }
    };

    const placeEdgeCenterPiece = (
      v: ResolvedVariant,
      role: PlacementRole,
      first: EdgeCtx,
      len: number,
      source: Placement["source"],
    ): void => {
      const along =
        first.orient === "h" ? { x: first.x + len / 2, y: first.y } : { x: first.x, y: first.y + len / 2 };
      const c = frame.point(along.x, along.y);
      const runsEW = first.orient === "h";
      const axisFix = v.geom.lengthAxis === "z" ? 6 : 0;
      const steps = ((runsEW ? 0 : frame.stepsForQuarters(1)) + axisFix) % 24;
      const deg = steps * 15 + v.rot;
      const off =
        v.geom.originAt === "minCorner"
          ? { x: 0, z: 0 }
          : rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
      emit(v, role, c.x - off.x, first.base, c.z - off.z, deg, source);
    };

    const fullCellDone = new Set<string>();
    const fullCells = new Map<
      string,
      { x: number; y: number; base: number; top: number; theme: ThemeId; roleName: string }
    >();
    const wallStyleOf = (ref: number): string => (ref === NONE ? "wall" : (L.wallStyles[ref] ?? "wall"));

    // buildings build their own shell (compile/structure.ts)
    const claimed = structureClaims(L);
    // generator 4: a built interior is carved into a solid mass: a flat cap on the solid cells round the rooms, closed
    // on its outer edge by a skirt of the level's wall style (compile/shell.ts). The cap piece comes first: with no
    // cap tile in any palette the shell is left out whole.
    const carvedLevel = !L.structures?.length && L.cells.state.some((s) => s === CELL.SOLID);
    // ... and only a rough interior gets broken wall tops (a kept-up timber inn keeps clean walls)
    const roughMap = gen.interiorWallTops && carvedLevel ? roughCells(L) : null;
    const roughCellAt = (x: number, y: number): boolean => {
      if (!roughMap || !V.inBounds(x, y)) return false;
      return roughMap[(y - L.bounds.y) * L.bounds.w + (x - L.bounds.x)] === 1;
    };
    let shell = gen.solidShell && carvedLevel
      ? planShell(resolved, L, seed, (o, e) => claimed.edges.has(`${o}${e}`), defaultTheme)
      : null;
    const capRes = shell ? lookup(L.id, shell.theme, ["cap.solid"], undefined, true) : null;
    const capVariants = (capRes?.variants ?? []).filter((v) => v.weight > 0 && v.footprint[0] === v.footprint[1]);
    if (shell && capVariants.length === 0) shell = shell.strips.length > 0 ? { ...shell, cells: new Map(), edges: [] } : null;
    const capThick = capVariants.length > 0 ? Math.min(...capVariants.map((v) => v.geom.size.y)) : 0.5;
    const shellEdges = new Map<string, EdgeCtx>();
    if (shell)
      for (const se of shell.edges) {
        const e = se.orient === "h" ? V.hEdge(se.x, se.y) : V.vEdge(se.x, se.y);
        if (e < 0) continue;
        shellEdges.set(`${se.orient}${e}`, {
          orient: se.orient,
          x: se.x,
          y: se.y,
          hostFirst: se.hostFirst,
          hostX: se.hostX,
          hostY: se.hostY,
          otherX: se.orient === "h" ? se.x : se.hostFirst ? se.x : se.x - 1,
          otherY: se.orient === "h" ? (se.hostFirst ? se.y : se.y - 1) : se.y,
          otherOpen: false,
          planSide: se.planSide,
          base: shell.base,
          // the skirt stops a hair under the cap's lift: a whole 2-tall piece from the floor's underside to the cap tile
          top: se.top - capThick - SHELL.lift,
          theme: shell.theme,
          hostOpen: false,
        });
      }
    const doRuns = (orient: "h" | "v"): void => {
      const grid = orient === "h" ? L.hEdges : L.vEdges;
      const outer = orient === "h" ? V.h + 1 : V.w + 1;
      const inner = orient === "h" ? V.w : V.h;
      for (let o = 0; o < outer; o++) {
        let run: EdgeCtx[] = [];
        let runKey = "";
        let runStyle = "wall";
        const flush = (): void => {
          if (run.length) placeWallRun(run, runStyle);
          run = [];
          runKey = "";
        };
        for (let i = 0; i < inner; i++) {
          const x = orient === "h" ? L.bounds.x + i : L.bounds.x + o;
          const y = orient === "h" ? L.bounds.y + o : L.bounds.y + i;
          const e = orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y);
          const skirt = e >= 0 ? shellEdges.get(`${orient}${e}`) : undefined;
          if (skirt === undefined && (e < 0 || grid.kind[e] !== EDGE.WALL || claimed.edges.has(`${orient}${e}`))) {
            flush();
            continue;
          }
          const style = skirt && shell ? shell.style : wallStyleOf(grid.ref[e] ?? NONE);
          const height = (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2;
          const ctx = skirt ?? edgeCtx(orient, x, y, grid, e, height);
          const key = [ctx.hostFirst, style, ctx.theme, ctx.base, ctx.top].join("|");
          if (key !== runKey) flush();
          runKey = key;
          runStyle = style;
          run.push(ctx);
        }
        flush();
      }

      function placeWallRun(run: EdgeCtx[], style: string): void {
        const first = run[0];
        if (!first) return;
        const roleName = `wall.${style}`;
        const res = lookup(L.id, first.theme, [roleName]);
        if (!res) return;
        const mount = res.def.mount ?? "half-cell";
        if (mount === "full-cell") {
          for (const c of run) {
            // A rock block cannot stand in an open host cell; put it in the other cell when that one is rock, void or
            // outside the level (a cave touching the level bounds), otherwise skip it with a warning.
            const flip = c.hostOpen && !c.otherOpen;
            const bx = flip ? c.otherX : c.hostX;
            const by = flip ? c.otherY : c.hostY;
            const k = `${bx},${by}`;
            // generator 3: a passage that reaches the board edge is an exit; no rock column stands outside the bounds
            if (
              gen.boardEdgeExits &&
              (bx < L.bounds.x || bx >= L.bounds.x + L.bounds.w || by < L.bounds.y || by >= L.bounds.y + L.bounds.h)
            )
              continue;
            if (c.hostOpen && !flip) {
              if (fullCellDone.has(`x${k}`)) continue;
              fullCellDone.add(`x${k}`);
              addDiag({
                severity: "warning",
                code: "thick_wall_conflict",
                message: `Full-cell wall "${roleName}" would fill an open cell; skipped`,
                levelId: L.id,
                role: roleName,
                cell: [c.hostX, c.hostY],
              });
              continue;
            }
            // one column per rock cell, spanning every edge it closes (a cell beside a chasm and its rim gets one
            // column from the chasm floor to the rim wall top)
            const prev = fullCells.get(k);
            if (prev) {
              prev.base = Math.min(prev.base, c.base);
              prev.top = Math.max(prev.top, c.top);
            } else fullCells.set(k, { x: bx, y: by, base: c.base, top: c.top, theme: c.theme, roleName });
          }
          return;
        }
        const lengths = [...new Set(res.variants.filter((v) => v.weight > 0).map(lengthOf))].sort(
          (a, b) => b - a,
        );
        const greedy = res.def.greedyTiling !== false;
        let i = 0;
        while (i < run.length) {
          const remaining = run.length - i;
          const cands = (greedy ? lengths : [1]).filter((n) => n <= remaining);
          const shortest = lengths.length > 0 ? Math.min(...lengths) : 1;
          if (mount === "edge-center" && remaining < shortest) {
            // free-standing low walls/fences/railings: a run shorter than the shortest piece gets that piece centred
            // over it (it overhangs a little), rather than a gap
            const r = lookup(L.id, first.theme, [roleName], lenFilter(shortest), true);
            const v = r
              ? pick(r.variants, `${L.id}:${orient}wall:${run[i]?.x ?? 0}:${run[i]?.y ?? 0}`)
              : undefined;
            const c = run[i];
            if (v && c) {
              placeEdgeCenterPiece(v, "wall", c, remaining, {
                cell: [c.hostX, c.hostY],
                elementId: roleName,
              });
              i += remaining;
              continue;
            }
          }
          let done = false;
          for (const n of [...cands, 1]) {
            let r = lookup(L.id, first.theme, [roleName], lenFilter(n), n !== 1);
            let v = r
              ? pick(r.variants, `${L.id}:${orient}wall:${run[i]?.x ?? 0}:${run[i]?.y ?? 0}`)
              : undefined;
            const c = run[i];
            if (!v || !c) continue;
            // generator 4, rough interiors: about one piece in five of a run is a broken-top variant (wall.ruined)
            if (
              roughMap !== null &&
              style === "wall" &&
              n >= 2 &&
              c.hostOpen &&
              roughCellAt(c.hostX, c.hostY) &&
              h32(`${seed}:${L.id}:brokentop:${orient}:${c.x}:${c.y}`) % 5 === 0
            ) {
              const rr = lookup(L.id, first.theme, ["wall.ruined"], lenFilter(n), true);
              const rv = rr ? pick(rr.variants, `${L.id}:${orient}broken:${c.x}:${c.y}`) : undefined;
              if (rr && rv && (rr.def.mount ?? "half-cell") === "half-cell") {
                r = rr;
                v = rv;
              }
            }
            if (mount === "edge-center")
              placeEdgeCenterPiece(v, "wall", c, n, { cell: [c.hostX, c.hostY], elementId: roleName });
            else {
              const count = Math.max(1, Math.ceil((c.top - c.base) / v.unitHeight - EPS));
              // generator 4: a wall a quarter or half a tile short of whole pieces sinks into the floor slab so its top
              // lands where the edge says (rough tops, resolve/wallTops.ts); the piece never lifts off the floor
              const yBase = gen.exactWallTops
                ? Math.max(c.base - 0.5, Math.min(c.base, c.top - count * v.unitHeight))
                : c.base;
              placeEdgePiece(
                v,
                "wall",
                r?.role ?? roleName,
                c,
                n,
                yBase,
                count,
                { cell: [c.hostX, c.hostY], elementId: roleName },
                false,
              );
              for (let k = 0; k < n; k++) {
                const ck = run[i + k];
                if (ck)
                  registerEdgeStrip(orient, ck.x, ck.y, {
                    orient,
                    side: opposite(ck.planSide),
                    style,
                    theme: ck.theme,
                    base: ck.base,
                    top: ck.top,
                  });
              }
            }
            i += n;
            done = true;
            break;
          }
          if (!done) i++;
        }
      }
    };
    doRuns("h");
    doRuns("v");
    // generator 4: the flat cap of the solid shell, flush with the wall tops, in the palette's biggest square pieces
    if (shell && capRes) {
      const sizes = [...new Set(capVariants.map((v) => v.footprint[0]))].sort((a, b) => b - a);
      const capUsed = new Set<string>();
      const cells = [...shell.cells.values()].sort((a, b) => a.y - b.y || a.x - b.x);
      // the shell's blocks lie on the level's even lattice: big tiles go there first, then big tiles anywhere they fit
      // (the strip against a wall that is off the lattice), then singles
      const passes: Array<{ s: number; aligned: boolean }> = [
        ...sizes.filter((s) => s > 1).map((s) => ({ s, aligned: true })),
        ...sizes.filter((s) => s > 1).map((s) => ({ s, aligned: false })),
        { s: 1, aligned: false },
      ];
      for (const { s, aligned } of passes) {
        if (!sizes.includes(s)) continue;
        for (const c of cells) {
          if (capUsed.has(`${c.x},${c.y}`)) continue;
          if (aligned && ((c.x - L.bounds.x) % s !== 0 || (c.y - L.bounds.y) % s !== 0)) continue;
          let fits = true;
          for (let dy = 0; fits && dy < s; dy++)
            for (let dx = 0; fits && dx < s; dx++) {
              const cc = shell.cells.get(`${c.x + dx},${c.y + dy}`);
              if (!cc || capUsed.has(`${c.x + dx},${c.y + dy}`) || cc.theme !== c.theme || cc.top !== c.top) fits = false;
            }
          if (!fits) continue;
          const v = pick(
            capVariants.filter((q) => q.footprint[0] === s),
            `${L.id}:cap:${c.x}:${c.y}`,
          );
          if (!v) continue;
          for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) capUsed.add(`${c.x + dx},${c.y + dy}`);
          const m = frame.rectMin(c.x, c.y, s, s);
          const steps = (h32(`${seed}:${L.id}:caprot:${c.x}:${c.y}`) % 4) * 6;
          emit(v, "fill", m.x, c.top - v.geom.size.y, m.z, steps * 15 + v.rot, {
            cell: [c.x, c.y],
            elementId: "shell",
          });
        }
      }
    }
    // generator 4: in a tidy interior, a one-cell solid strip between two rooms is closed flush at wall-top height with a
    // tile of the floor of the room it joins, so two rooms read as sharing one thick wall instead of a trench
    if (shell && shell.strips.length > 0) {
      for (const s of shell.strips) {
        const sr = lookup(
          L.id,
          s.theme,
          // the floor role of the room the strip joins; the palette's own fallback chain covers a material it lacks
          s.material ? [`floor.${s.material}`] : ["cap.solid"],
          { key: "strip1x1", test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1 },
          true,
        );
        const sv = sr ? pick(sr.variants.filter((v) => v.weight > 0), `${L.id}:strip:${s.x}:${s.y}`) : undefined;
        if (!sv) continue;
        const m = frame.rectMin(s.x, s.y, 1, 1);
        emit(sv, "fill", m.x, s.top - sv.geom.size.y, m.z, sv.rot, { cell: [s.x, s.y], elementId: "shell" });
      }
    }
    // Generator 2: rock walls reach down to the lowest floor of the level (nothing below the room shows from outside)
    // and vary in height like a natural cave (0, 1 or 2 extra blocks from seeded value noise).
    const rockSkirt = gen.rockWallSkirt;
    const skirt = elev + w.outsideGround;
    const wallNoise = new ValueNoise(h32(`${seed}:${L.id}:walltops`));
    // the extra blocks never rise through the floor of a level stacked above (verify_pokes_into_level_above)
    const ceiling = resolved.levels.reduce(
      (m, o) => (o.elevation > elev + EPS ? Math.min(m, o.elevation) : m),
      Infinity,
    );
    const massFaces: Array<WallFace & { theme: ThemeId }> = [];
    const columnLater = new Map<string, () => void>();
    for (const [k, c] of fullCells) {
      const r1 = lookup(L.id, c.theme, [c.roleName], {
        key: "1x1",
        test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1,
      });
      const v = r1 ? pick(r1.variants, `${L.id}:wallblock:${k}`) : undefined;
      if (!v) continue;
      const m = frame.rectMin(c.x, c.y, 1, 1);
      let base = c.base;
      let top = c.top;
      const floorTop = c.base;
      if (rockSkirt) {
        base = Math.min(base, skirt);
        // clustered: broad noise picks masses (up to 3 blocks taller) and a few lower stretches (1 block down, never
        // below a tile above the floor), a per-cell hash breaks up runs of equal columns
        const nz =
          wallNoise.sample(c.x / 4, c.y / 4) * 0.8 + (h32(`${seed}:${c.x}:${c.y}:wt`) / 4294967296) * 0.2;
        let extra = nz < 0.22 ? -1 : nz < 0.45 ? 0 : nz < 0.62 ? 1 : nz < 0.8 ? 2 : 3;
        // generator 3: the column is the closing skin of a wall of rock mass (gen/cavewall.ts): lower, in uneven runs
        if (gen.caveRockMass && c.roleName === "wall.cave_rock") extra =nz < 0.3 ? -1 : nz < 0.72 ? 0 : 1;
        if (extra < 0 && top - v.unitHeight < floorTop + 1.5) extra = 0;
        // a column that closes the mouth of a chasm or pit (its wall reaches below the floor) is never one of the
        // low stretches, and stands at least a block taller, so nothing glows over it from inside
        if (c.base < elev + 0.5 - 0.75) extra = Math.max(extra, 1);
        while (extra > 0 && top + extra * v.unitHeight > ceiling + EPS) extra--;
        top += extra * v.unitHeight;
      }
      const n = Math.max(1, Math.ceil((top - base) / v.unitHeight - EPS));
      // generator 2: a block that would rise through the floor above is dropped to sit just under it (overlapping
      // the block below), so a stacked cave keeps its wall closed without poking into the level above
      const yAt = (s: number): number => {
        const y = base + s * v.unitHeight;
        return rockSkirt && y + v.unitHeight > ceiling + EPS && ceiling - v.unitHeight >= base - EPS
          ? ceiling - v.unitHeight
          : y;
      };
      const buildColumn = (): void => {
        for (let s = 0; s < n; s++)
          emit(v, "wall", m.x, yAt(s), m.z, v.rot + (rockSkirt ? blockTurn(v, `${k}:${s}`) : 0), {
            cell: [c.x, c.y],
            elementId: c.roleName,
          });
      };
      // generator 3: the column is only the fill of a wall of rock mass (gen/cavewall.ts); it is built below, where
      // no mass piece closes the face cell
      if (gen.caveRockMass && c.roleName === "wall.cave_rock") {
        massFaces.push({ x: c.x, y: c.y, base, top: base + n * v.unitHeight, edgeBase: floorTop, theme: c.theme });
        columnLater.set(`${c.x},${c.y}`, buildColumn);
      } else buildColumn();
    }

    // generator 3: the rock mass behind and over the wall columns (gen/cavewall.ts)
    if (massFaces.length > 0) {
      const edgeBlocked = new Set<string>();
      for (const orient of ["h", "v"] as const) {
        const g = orient === "h" ? L.hEdges : L.vEdges;
        for (let y = L.bounds.y; y <= L.bounds.y + V.h; y++)
          for (let x = L.bounds.x; x <= L.bounds.x + V.w; x++) {
            const e = orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y);
            if (e < 0 || (g.kind[e] !== EDGE.OPENING && g.kind[e] !== EDGE.STAIR)) continue;
            for (let dy = -2; dy <= 2; dy++)
              for (let dx = -2; dx <= 2; dx++) edgeBlocked.add(`${x + dx},${y + dy}`);
          }
      }
      const taken = new Set<string>();
      for (const f of L.features)
        for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
          for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++)
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) taken.add(`${x + dx},${y + dy}`);
      for (const theme of new Set(massFaces.map((f) => f.theme))) {
        const vars: Array<{ v: ResolvedVariant; role: string }> = [];
        const shapes: WallShape[] = [];
        const add = (
          roleName: string,
          family: WallShape["family"],
          ok: (q: ResolvedVariant) => boolean,
          lift?: (q: ResolvedVariant) => number,
        ) => {
          const r = lookup(L.id, theme, [roleName], undefined, true);
          for (const q of r?.variants ?? []) {
            if (q.weight <= 0 || !ok(q)) continue;
            shapes.push({
              id: vars.length,
              family,
              w: q.geom.size.x,
              d: q.geom.size.z,
              h: q.geom.size.y,
              weight: q.weight,
              ...(lift === undefined ? {} : { lift: lift(q) }),
            });
            vars.push({ v: q, role: r?.role ?? roleName });
          }
        };
        // one rock family per cave: the Cavern kit (cliff.cave_mass), the tone of the wall columns; themes without it
        // build the mass from their own cliff band rock (crest boulders and faces)
        add("cliff.cave_mass", "A", () => true);
        const kit = shapes.length > 0;
        if (!kit) {
          add("cliff.formation_crest", "A", (q) => q.geom.size.y >= 1.2);
          add("cliff.formation_face", "A", () => true);
        }
        // flat sheets close the far part of a deep band
        if (kit) add("cliff.cave_cap", "cap", () => true);
        // foot stones: the kit's low stone, else small rocks and rubble
        if (kit) add("cliff.cave_mass", "toe", (q) => q.geom.size.y <= 1.05, () => 0);
        else {
          add("feature.rock", "toe", (q) => q.geom.size.y <= 0.8 && q.geom.size.x >= 0.9, () => 0);
          add("feature.rubble", "toe", (q) => q.geom.size.y <= 0.8 && q.geom.size.x >= 0.8, () => 0);
        }
        if (!shapes.some((s) => s.family !== "toe")) continue;
        const faces = massFaces.filter((f) => f.theme === theme);
        const inLevelState = (x: number, y: number): number =>
          V.inBounds(x, y) ? (L.cells.state[(y - L.bounds.y) * V.w + (x - L.bounds.x)] ?? CELL.VOID) : -1;
        const plan = planCaveWall({
          seed: h32(`${seed}:${L.id}:cavemass`),
          faces,
          bounds: { x: L.bounds.x, y: L.bounds.y, w: V.w, h: V.h },
          // (a level of rooms and caves: the cells the shell owns are not the rock's, gen/solidMass.ts)
          rock: (x, y) => inLevelState(x, y) === CELL.SOLID && (shell?.rockMayTake(x, y) ?? true),
          open: (x, y) => V.cell(x, y).open,
          floorTop: (x, y) => topOf(V.cell(x, y)),
          toeOk: (x, y) => {
            const c = V.cell(x, y);
            return (
              c.floor &&
              (c.flags & (CELL_FLAG.PATH | CELL_FLAG.LINK | CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR)) === 0 &&
              !taken.has(`${x},${y}`) &&
              !edgeBlocked.has(`${x},${y}`)
            );
          },
          shapes,
          ceiling,
          // generator 4: solid rock, filled from the foot with no see-through gap
          ...(gen.solidCaveRock ? { solid: true } : {}),
        });
        for (const f of faces) if (!plan.columns.has(`${f.x},${f.y}`)) columnLater.delete(`${f.x},${f.y}`);
        for (const pc of plan.pieces) {
          const q = vars[pc.shape];
          if (!q) continue;
          const deg = (((frame.planDegreesToWorld(pc.rot) + q.v.rot) % 360) + 360) % 360;
          const c = frame.point(pc.cx, pc.cy);
          const off = rotateXZ(q.v.geom.boundsCenter.x, q.v.geom.boundsCenter.z, deg * frame.o.rotSense);
          emit(q.v, pc.family === "toe" ? "feature" : "wall", c.x - off.x, pc.base, c.z - off.z, deg, {
            cell: [Math.floor(pc.cx), Math.floor(pc.cy)],
            elementId: pc.family === "toe" ? "cave_foot" : pc.family === "cap" ? "cave_cap" : "cave_mass",
          });
          // a tile (corner-origin) piece turned off the quarter turns: its box is the turned outline's (the box of a
          // corner-origin piece is only right for quarter turns)
          const last = placements[placements.length - 1];
          if (last && q.v.geom.originAt === "minCorner") {
            const box = placementBox(
              { ...q.v.geom, originAt: "other" },
              last.x,
              last.y,
              last.z,
              last.rot * orientation.rotSense,
            );
            placementBoxes.set(last, box);
            growBox(levelBox, box);
          }
        }
      }
    }
    // the wall columns left as fill (all of them where no mass was planned)
    for (const build of columnLater.values()) build();

    // kerbs along kerbed paths: kerb.<material> / kerb.default, a half-cell piece on the path side of the edge
    for (const kb of L.kerbs ?? []) {
      const c = V.cell(kb.at[0], kb.at[1]);
      const res = lookup(L.id, c.theme, [`kerb.${kb.material}`, "kerb.default"], lenFilter(1), true);
      const v = res ? pick(res.variants, `${L.id}:kerb:${kb.at[0]}:${kb.at[1]}:${kb.side}`) : undefined;
      if (!v || !res) {
        if (!kerbNoted) {
          kerbNoted = true;
          addDiag({
            severity: "info",
            code: "role_missing",
            message: `No kerb piece (kerb.${kb.material}, kerb.default) in theme "${c.theme}"; paths are built without kerbs`,
            levelId: L.id,
            role: `kerb.${kb.material}`,
          });
        }
        continue;
      }
      const s = kb.side;
      const ex = s === "E" ? kb.at[0] + 1 : kb.at[0];
      const ey = s === "S" ? kb.at[1] + 1 : kb.at[1];
      const orient: "h" | "v" = s === "N" || s === "S" ? "h" : "v";
      const ctx: EdgeCtx = {
        orient,
        x: ex,
        y: ey,
        // the kerb stands on the verge, beside the path, never on the path cell itself
        hostFirst: s === "N" || s === "W",
        hostX: s === "E" ? kb.at[0] + 1 : s === "W" ? kb.at[0] - 1 : kb.at[0],
        hostY: s === "S" ? kb.at[1] + 1 : s === "N" ? kb.at[1] - 1 : kb.at[1],
        otherX: kb.at[0],
        otherY: kb.at[1],
        otherOpen: true,
        planSide: opposite(s),
        base: topOf(c),
        top: topOf(c) + v.unitHeight,
        theme: c.theme,
        hostOpen: true,
      };
      placeEdgePiece(
        v,
        "ledge",
        res.role,
        ctx,
        1,
        topOf(c),
        1,
        { cell: [kb.at[0], kb.at[1]], elementId: "kerb" },
        false,
      );
    }

    // stairs (EDGE.STAIR): a stair piece in the lower cell climbing toward the higher one
    const stairAt = (orient: "h" | "v", e: number, x: number, y: number): void => {
      const g = orient === "h" ? L.hEdges : L.vEdges;
      if (g.kind[e] !== EDGE.STAIR) return;
      const a = orient === "h" ? { x, y: y - 1 } : { x: x - 1, y };
      const b = { x, y };
      const ca = V.cell(a.x, a.y);
      const cb = V.cell(b.x, b.y);
      if (!ca.floor || !cb.floor) return;
      const lowerIsA = ca.height < cb.height;
      const lo = lowerIsA ? a : b;
      const cl = lowerIsA ? ca : cb;
      const rise = Math.abs(ca.height - cb.height);
      const dir: Side = orient === "h" ? (lowerIsA ? "S" : "N") : lowerIsA ? "E" : "W";
      const roles =
        rise >= 0.75 - EPS && rise <= 1.25 + EPS
          ? // natural ground may have its own stair piece (earth or rock steps) before the built one
            cl.material && NATURAL_GROUND.has(cl.material)
            ? [`link.stairs.${cl.material}`, "link.stairs.natural", "link.stairs"]
            : ["link.stairs"]
          : cl.material
            ? NATURAL_GROUND.has(cl.material)
              ? [`step.${cl.material}`]
              : [`step.${cl.material}`, "step.default"]
            : ["step.default"];
      const res = lookup(L.id, cl.theme, roles, undefined, true);
      const v = res ? pick(res.variants, `${L.id}:step:${lo.x}:${lo.y}`) : undefined;
      if (!v || !res) return;
      // a step piece must fit under the step it climbs: one taller than the rise would stand as a block on the lower
      // floor (the riser is built anyway, from the cell's own floor or fill)
      if (!res.role.startsWith("link.stairs") && v.geom.size.y > rise + 0.05) return;
      const f = facingOf(v, "link", res.role);
      const steps = f.ascendsToward ? frame.stepsToFace(f.ascendsToward, frame.worldSide(dir)) : 0;
      const deg = steps * 15 + v.rot;
      const src: Placement["source"] = { cell: [lo.x, lo.y], elementId: "steps" };
      if (v.geom.originAt === "minCorner") {
        const m = frame.rectMin(lo.x, lo.y, 1, 1);
        emit(v, "link", m.x, topOf(cl), m.z, deg, src);
      } else {
        const ctr = frame.point(lo.x + 0.5, lo.y + 0.5);
        const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
        emit(v, "link", ctr.x - off.x, topOf(cl), ctr.z - off.z, deg, src);
      }
    };
    for (let ly = 0; ly <= V.h; ly++)
      for (let lx = 0; lx < V.w; lx++) stairAt("h", ly * V.w + lx, L.bounds.x + lx, L.bounds.y + ly);
    for (let ly = 0; ly < V.h; ly++)
      for (let lx = 0; lx <= V.w; lx++) stairAt("v", ly * (V.w + 1) + lx, L.bounds.x + lx, L.bounds.y + ly);

    // openings
    for (const op of L.openings) {
      if (op.kind === "open" || claimed.openings.has(op.id)) continue;
      const orient = op.orientation;
      const grid = orient === "h" ? L.hEdges : L.vEdges;
      const ctxs: EdgeCtx[] = [];
      for (let k = 0; k < op.width; k++) {
        const x = orient === "h" ? op.start[0] + k : op.start[0];
        const y = orient === "h" ? op.start[1] : op.start[1] + k;
        const e = orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y);
        if (e < 0) continue;
        ctxs.push(edgeCtx(orient, x, y, grid, e, (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2));
      }
      const first = ctxs[0];
      if (!first) continue;
      // all edges of one opening use the first edge's host side
      for (const c of ctxs) {
        if (c.hostFirst !== first.hostFirst) {
          const e = orient === "h" ? V.hEdge(c.x, c.y) : V.vEdge(c.x, c.y);
          // keep the edge's real wall height (was hard-coded to 2, leaving a gap above doors in taller walls)
          const h = (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2;
          Object.assign(
            c,
            edgeCtx(
              orient,
              c.x,
              c.y,
              { ...grid, host: grid.host.map(() => (first.hostFirst ? 0 : 1)) },
              e,
              h,
            ),
          );
        }
      }
      const roleName = `opening.${op.kind}`;
      const res = lookup(L.id, op.theme || first.theme, [roleName]);
      if (!res) continue;
      const lengths = [
        ...new Set(res.variants.filter((v) => v.weight > 0 || res.variants.length === 1).map(lengthOf)),
      ].sort((a, b) => b - a);
      let i = 0;
      while (i < ctxs.length) {
        const remaining = ctxs.length - i;
        const c = ctxs[i];
        if (!c) break;
        let placed = 0;
        for (const n of lengths.filter((l) => l <= remaining)) {
          const r = lookup(L.id, op.theme || first.theme, [roleName], lenFilter(n), true);
          const pool = r ? r.variants.filter((v) => v.weight > 0) : [];
          const v = r
            ? pool.length
              ? pick(pool, `${L.id}:opening:${op.id}:${i}`)
              : r.variants[0]
            : undefined;
          if (!v || !r) continue;
          const isDoor = r.role.startsWith("opening.");
          placeEdgePiece(
            v,
            r.role.startsWith("wall.") ? "wall" : "opening",
            r.role,
            c,
            n,
            c.base,
            1,
            { cell: [c.hostX, c.hostY], elementId: op.id },
            isDoor,
          );
          // generator 4: a secret door is ONE removable plug in the wall line (the palette's `opening.secret_door` piece, else
          // the wall style's own piece); the build report says where it stands so a GM can find and delete it
          if (op.kind === "secret_door" && gen.secretDoorPlug && i === 0) {
            const sideName = { N: "north", S: "south", E: "east", W: "west" }[c.planSide];
            const [a, b] = op.sides;
            addDiag({
              severity: "info",
              code: "secret_door_plug",
              message: `Secret door ${op.id} between ${a ?? "?"} and ${b ?? "?"} on level ${L.id} at cell ${c.hostX},${c.hostY} (${sideName} wall, floor level ${c.base}): delete the ${v.name} standing in that wall to open the way.`,
              levelId: L.id,
              elementId: op.id,
              role: r.role,
            });
          }
          // wall pieces above a door shorter than the wall
          const leafTop = c.base + v.unitHeight;
          const wallTop = Math.max(...ctxs.slice(i, i + n).map((q) => q.top));
          for (let k = 0; k < n; k++) {
            const ck = ctxs[i + k];
            if (!ck) continue;
            registerEdgeStrip(orient, ck.x, ck.y, {
              orient,
              side: opposite(ck.planSide),
              style: op.wallStyle,
              theme: ck.theme,
              base: ck.base,
              top: wallTop,
            });
            if (wallTop > leafTop + 0.25 - EPS) {
              const wr = lookup(L.id, ck.theme, [`wall.${op.wallStyle}`], lenFilter(1), true);
              const wv = wr ? pick(wr.variants, `${L.id}:lintel:${ck.x}:${ck.y}`) : undefined;
              if (wv && (wr?.def.mount ?? "half-cell") === "half-cell") {
                const cnt = Math.ceil((wallTop - leafTop) / wv.unitHeight - EPS);
                placeEdgePiece(
                  wv,
                  "wall",
                  `wall.${op.wallStyle}`,
                  ck,
                  1,
                  leafTop,
                  cnt,
                  { cell: [ck.hostX, ck.hostY], elementId: op.id },
                  false,
                );
              }
            } else if (isDoor && !NO_LINTEL.has(r.role)) {
              // Kit walls are visually taller than their doors (in-game 2026-11-18): close the notch with the
              // kit's lintel piece when the palette has one (data-driven; absent role = no lintel, no warning).
              const lr = lookup(
                L.id,
                op.theme || ck.theme,
                [`lintel.${op.wallStyle}`, "lintel.wall"],
                lenFilter(1),
                true,
              );
              const lv = lr ? pick(lr.variants, `${L.id}:lintel:${ck.x}:${ck.y}`) : undefined;
              if (lv) {
                placeEdgePiece(
                  lv,
                  "opening",
                  lr?.role ?? "lintel.wall",
                  ck,
                  1,
                  leafTop,
                  1,
                  { cell: [ck.hostX, ck.hostY], elementId: op.id },
                  false,
                );
              }
            }
          }
          placed = n;
          break;
        }
        if (!placed) {
          // An archway left as a plain gap is still a correct, passable opening: info, not a warning.
          const isArch = op.kind === "archway";
          addDiag({
            severity: isArch ? "info" : "warning",
            code: "role_missing",
            message: isArch
              ? `No ${remaining}-wide arch piece in the palette for archway ${op.id}; it is built as a plain opening`
              : `No "${roleName}" piece fits the remaining ${remaining}-edge span; left open`,
            levelId: L.id,
            role: roleName,
            elementId: op.id,
          });
          break;
        }
        i += placed;
      }
    }

    // corner posts: quadrants around a vertex left uncovered where an h strip and a v strip meet
    for (const [k, list] of strips) {
      const [vx, vy] = k.split(",").map(Number) as [number, number];
      const covered = new Set(
        list.map((s) => (s.orient === "h" ? `${s.side}${s.dir}` : `${s.dir}${s.side}`)),
      );
      const gaps = new Map<string, { a: Strip; b: Strip }>();
      for (const a of list.filter((s) => s.orient === "h")) {
        for (const b of list.filter((s) => s.orient === "v")) {
          if (a.dir === b.side || b.dir === a.side) continue;
          const q = `${a.side}${b.side}`;
          if (covered.has(q) || gaps.has(q)) continue;
          gaps.set(q, { a, b });
        }
      }
      for (const [q, { a, b }] of gaps) {
        const qy = q[0] as "N" | "S";
        const qx = q[1] as "W" | "E";
        const style = a.style;
        const res = lookup(L.id, a.theme, [`wall_post.${style}`, "wall_post.wall"]);
        const v = res ? pick(res.variants, `${L.id}:post:${k}:${q}`) : undefined;
        if (!v) continue;
        const px = qx === "W" ? vx - 0.5 : vx;
        const py0 = qy === "N" ? vy - 0.5 : vy;
        const m = frame.rectMin(px, py0, 0.5, 0.5);
        const base = Math.min(a.base, b.base);
        const top = Math.max(a.top, b.top);
        // generator 4: a post up to half a tile (a quarter for a 1-tall piece) short of whole pieces stops there; walls
        // beside a room raised a quarter tile stand that much taller than the post's own course, which would otherwise
        // stack a second 2-tall piece through the floor above
        const slack = gen.exactWallTops ? Math.min(0.5, v.unitHeight / 4) : 0;
        const n = Math.max(1, Math.ceil((top - base - slack) / v.unitHeight - EPS));
        const cellX = Math.floor(px);
        const cellY = Math.floor(py0);
        for (let s = 0; s < n; s++)
          emit(v, "wall_post", m.x, base + s * v.unitHeight, m.z, v.rot, {
            cell: [cellX, cellY],
            elementId: `post:${k}`,
          });
      }
    }

    // ── 4. links (placed on the lower level) ──
    for (const lk of resolved.links) {
      if (lk.kind === "trapdoor") {
        // the hatch lies on the UPPER level's floor (the resolver keeps that floor for trapdoors)
        if (lk.toLevel === L.id) placeHatch(lk);
        continue;
      }
      if (lk.fromLevel !== L.id) continue;
      if (lk.kind === "pit_drop") continue;
      const roleName = `link.${lk.kind}`;
      const firstCell = lk.lowerCells[0];
      if (!firstCell) continue;
      const theme = lk.theme || V.cell(firstCell[0], firstCell[1]).theme;
      const res = lookup(L.id, theme, [roleName]);
      if (!res) continue;
      const pool = res.variants.filter((v) => v.weight > 0);
      const v = pick(pool.length ? pool : res.variants, `${L.id}:link:${lk.id}`);
      if (!v) continue;
      const f = facingOf(v, "link", res.role);
      const wdir = frame.worldSide(lk.dir);
      const steps = f.ascendsToward ? frame.stepsToFace(f.ascendsToward, wdir) : 0;
      if (lk.kind === "stairs" || lk.kind === "ramp") {
        const xs = lk.lowerCells.map((c) => c[0]);
        const ys = lk.lowerCells.map((c) => c[1]);
        const minX = Math.min(...xs),
          maxX = Math.max(...xs),
          minY = Math.min(...ys),
          maxY = Math.max(...ys);
        for (const [cx, cy] of lk.lowerCells) {
          const kIdx =
            lk.dir === "N" ? maxY - cy : lk.dir === "S" ? cy - minY : lk.dir === "E" ? cx - minX : maxX - cx;
          const c = V.cell(cx, cy);
          const lowerTop = c.floor ? topOf(c) : elev + 0.5;
          const rise = v.unitHeight;
          const m = frame.rectMin(cx, cy, 1, 1);
          if ((kIdx + 1) * rise <= lk.rise + EPS) {
            const base = lowerTop + kIdx * rise;
            if (base > lowerTop + EPS)
              stackFill(w, L.id, theme, c.material, cx, cy, lowerTop, base, "link", lk.id);
            emit(v, "link", m.x, base, m.z, steps * 15 + v.rot, { cell: [cx, cy], elementId: lk.id });
          } else {
            // landing: the rest of a non-integer rise as fill courses up to the upper floor top
            stackFill(w, L.id, theme, c.material, cx, cy, lowerTop, lowerTop + lk.rise, "link", lk.id);
          }
        }
      } else {
        // Vertical links (ladder, spiral stairs): ONE stack of the resolved asset, from the lower floor top until it
        // reaches the upper floor top. The count comes from the asset's height versus the real span (rise 2.5, 5.0,
        // …), never from the link kind. An asset smaller than the link's footprint (a ladder standing in for spiral
        // stairs) goes once, into a cell of the footprint against a wall when there is one.
        const xs = lk.lowerCells.map((c) => c[0]);
        const ys = lk.lowerCells.map((c) => c[1]);
        const rx = Math.min(...xs);
        const ry = Math.min(...ys);
        const rw = Math.max(...xs) - rx + 1;
        const rh = Math.max(...ys) - ry + 1;
        const coversLink = v.footprint[0] * v.footprint[1] >= lk.lowerCells.length;
        const walledSide = (x: number, y: number): boolean =>
          (["N", "E", "S", "W"] as const).some((s) => {
            const e =
              s === "N"
                ? V.hEdge(x, y)
                : s === "S"
                  ? V.hEdge(x, y + 1)
                  : s === "W"
                    ? V.vEdge(x, y)
                    : V.vEdge(x + 1, y);
            const g = s === "N" || s === "S" ? L.hEdges : L.vEdges;
            return e >= 0 && g.kind[e] === EDGE.WALL;
          });
        const sorted = [...lk.lowerCells].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
        const cell: readonly [number, number] = coversLink
          ? [rx, ry]
          : (sorted.find(([x, y]) => walledSide(x, y)) ?? sorted[0] ?? [rx, ry]);
        const [cx, cy] = cell;
        const w = coversLink ? rw : 1;
        const h = coversLink ? rh : 1;
        const c = V.cell(cx, cy);
        const base = c.floor ? topOf(c) : elev + 0.5;
        const upView = views.get(lk.toLevel);
        const upperTop = upView
          ? upView.L.elevation + upView.cell(cx, cy).height + 0.5
          : elev + c.height + 0.5 + lk.rise;
        const count = Math.max(1, Math.ceil((upperTop - base) / v.unitHeight - EPS));
        const deg = steps * 15 + v.rot;
        const src: Placement["source"] = { cell: [cx, cy], elementId: lk.id };
        if (res.role !== roleName && !coversLink) {
          addDiag({
            severity: "info",
            code: "asset_substituted",
            message: `${lk.kind === "spiral_stairs" ? "Spiral stairs" : `Link (${lk.kind})`} ${lk.id} built as ${v.name ?? res.role} in one cell: no ${roleName} asset in this palette`,
            levelId: L.id,
            elementId: lk.id,
            role: roleName,
          });
        }
        if (v.geom.originAt === "minCorner") {
          const m = frame.rectMin(cx, cy, w, h);
          for (let s = 0; s < count; s++) emit(v, "link", m.x, base + s * v.unitHeight, m.z, deg, src);
        } else {
          const centre = frame.point(cx + w / 2, cy + h / 2);
          const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
          for (let s = 0; s < count; s++)
            emit(v, "link", centre.x - off.x, base + s * v.unitHeight, centre.z - off.z, deg, src);
        }
      }
    }

    function placeHatch(lk: ResolvedPlan["links"][number]): void {
      const cell = lk.upperCells[0] ?? lk.arrival;
      const c = V.cell(cell[0], cell[1]);
      const res = lookup(L.id, lk.theme || c.theme, ["link.trapdoor"]);
      const pool = res ? res.variants.filter((u) => u.weight > 0) : [];
      const v = res ? pick(pool.length ? pool : res.variants, `${L.id}:hatch:${lk.id}`) : undefined;
      if (!v) return;
      const m = frame.rectMin(cell[0], cell[1], 1, 1);
      emit(v, "link", m.x, c.floor ? topOf(c) : elev + 0.5, m.z, v.rot, {
        cell: [cell[0], cell[1]],
        elementId: lk.id,
      });
    }

    /** True when any edge along `side` of the plan rect is a wall (or a door) edge. */
    const rectSideWalled = (x: number, y: number, w: number, h: number, side: Side): boolean => {
      const n = side === "N" || side === "S" ? w : h;
      for (let k = 0; k < n; k++) {
        const e =
          side === "N"
            ? V.hEdge(x + k, y)
            : side === "S"
              ? V.hEdge(x + k, y + h)
              : side === "W"
                ? V.vEdge(x, y + k)
                : V.vEdge(x + w, y + k);
        const g = side === "N" || side === "S" ? L.hEdges : L.vEdges;
        if (e >= 0 && (g.kind[e] === EDGE.WALL || g.kind[e] === EDGE.OPENING)) return true;
      }
      return false;
    };
    const wallFacing = new Set(orientation.wallFacingFeatures ?? []);

    // ── 5. features ──
    for (const f of L.features) placeFeature(f);

    // outcrops are built up with the theme's rock formations: one on the crown, and formations and edge dressing
    // piled round the foot, so a crag reads as a rock mass rather than a stack of blocks
    for (const oc of L.outcrops ?? []) {
      const inOc = new Set(oc.cells.map(([x, y]) => `${x},${y}`));
      const placeDressing = (role: string, x: number, y: number, key: string): void => {
        const c = V.cell(x, y);
        const res = lookup(L.id, c.theme, [role], undefined, true);
        const v = res ? pick(res.variants, `${L.id}:outcrop:${oc.id}:${key}`) : undefined;
        if (!v) return;
        const src: Placement["source"] = { cell: [x, y], elementId: `outcrop:${oc.id}` };
        const turn = h32(`${seed}:${oc.id}:${key}:rot`);
        if (v.geom.originAt === "minCorner") {
          const m = frame.rectMin(x, y, v.footprint[0], v.footprint[1]);
          emit(v, "feature", m.x, topOf(c), m.z, (turn % 4) * 90 + v.rot, src);
          return;
        }
        const deg = (turn % 24) * 15 + v.rot;
        const ctr = frame.point(x + 0.5, y + 0.5);
        const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
        emit(v, "feature", ctr.x - off.x, topOf(c), ctr.z - off.z, deg, src);
      };
      const crown = [...oc.cells].sort(
        (a, b) => V.cell(b[0], b[1]).height - V.cell(a[0], a[1]).height || a[1] - b[1] || a[0] - b[0],
      )[0];
      if (crown) placeDressing("feature.formation", crown[0], crown[1], "crown");
      const foot = new Map<string, [number, number]>();
      for (const [x, y] of oc.cells)
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (!inOc.has(`${nx},${ny}`) && V.cell(nx, ny).floor) foot.set(`${nx},${ny}`, [nx, ny]);
        }
      [...foot.values()]
        .sort((a, b) => a[1] - b[1] || a[0] - b[0])
        .forEach(([x, y], i) => {
          const r = h32(`${seed}:${oc.id}:${x}:${y}:foot`) % 3;
          if (r === 0)
            placeDressing(i % 2 === 0 ? "feature.formation" : "feature.edge_dressing", x, y, `${x}:${y}`);
        });
    }

    function placeFeature(f: ResolvedFeature): void {
      const anchor = V.cell(f.at[0], f.at[1]);
      const theme = f.theme || anchor.theme;
      const roleName = `feature.${f.type}`;
      // generator 4: a covered stall is built from parts (base, counters, posts, canopy); without them the table below
      if (
        gen.coveredStalls &&
        f.type === "stall" &&
        f.stall !== undefined &&
        realizeStall(
          {
            frame,
            seed,
            lookup: (t, roles, filter, quiet) => lookup(L.id, t, roles, filter, quiet),
            pick,
            facingOf,
            emit,
            info: (code, message, role) => {
              addDiag({
                severity: "info",
                code: code as CompileDiagnostic["code"],
                message,
                levelId: L.id,
                ...(role ? { role } : {}),
              });
            },
          },
          f,
        )
      )
        return;
      let v: ResolvedVariant | undefined;
      let rule = "facing";
      let resolvedRole: RoleName = roleName;
      if (f.type === "custom") {
        // a real match only (strict name search), and a plausible size for the thing asked: a wrong object is worse
        // than none (round 5: "car" once became a cardboard carton). Footprint area within 9× either way.
        const want = Math.max(1, f.size[0] * f.size[1]);
        const hits = palettes.availability.search(f.hint ?? "", undefined);
        const hit = hits.find((h) => {
          const [fw, fh] = footprintFromGeom(h.geom);
          const area = Math.max(1, fw * fh);
          return area <= want * 9 && area * 9 >= want;
        });
        if (!hit) {
          // no catalog at all is a setup problem (warning); a catalog with no such thing is information for the
          // model, which should pick another type or hint
          const noCatalog = palettes.availability.search("chest").length === 0;
          addDiag({
            severity: noCatalog ? "warning" : "info",
            code: "custom_unresolved",
            message: `Custom feature "${f.hint ?? ""}" matched no asset${noCatalog ? " (no TaleSpire catalog loaded)" : hits.length > 0 ? ` of a plausible size (nearest name match "${hits[0]?.name ?? ""}" is the wrong size)` : " whose name is that thing"}; nothing was placed. Try another hint or a feature type.`,
            levelId: L.id,
            elementId: f.id,
          });
          return;
        }
        const g = hit.geom;
        const fpHit = footprintFromGeom(g);
        addDiag({
          severity: "info",
          code: "custom_resolved",
          message: `Custom feature "${f.hint ?? ""}" is "${hit.name}" (${Math.round(g.size.y * 10) / 10} tiles tall, ${fpHit[0]}×${fpHit[1]} cells; feature is ${f.size[0]}×${f.size[1]})`,
          levelId: L.id,
          elementId: f.id,
        });
        v = {
          uuid: hit.uuid,
          wanted: hit.uuid,
          substituted: false,
          geom: g,
          name: hit.name,
          weight: 1,
          variant: undefined,
          footprint: footprintFromGeom(g),
          rot: 0,
          offset: { x: 0, y: 0, z: 0 },
          unitHeight: g.size.y,
          facing: undefined,
        };
      } else {
        // generator 4: small things on a surface (clutter, goods) are one family table over two roles (gen/surfaces.ts):
        // the first role that has the asked family wins, else the first role there is (the variant note below applies)
        const roles = gen.sharedSmallThings ? featureRoles(f.type) : [roleName];
        const wantFamily = f.variant;
        const res =
          (roles.length > 1 && wantFamily !== undefined
            ? lookup(L.id, theme, [...roles], { key: `variant:${wantFamily}`, test: (u) => u.variant === wantFamily }, true)
            : null) ?? lookup(L.id, theme, [...roles]);
        if (!res) return;
        resolvedRole = res.role;
        rule = res.def.rotation ?? "facing";
        let pool = res.variants;
        // generator 3: the band's rocks turn as the generator set them (the palette's role says "fixed", which left every
        // rock at one turn), and a boulder is a tall one (Moss Rock 01 is knee-high and hides no face)
        if (gen.restingCliffBand && (f.type === "cliff_face" || f.type === "cliff_crest")) {
          rule = "inherit";
          if (f.type === "cliff_crest") {
            const tallOnes = pool.filter((u) => u.geom.size.y >= 1.2);
            if (tallOnes.length > 0) pool = tallOnes;
          }
          // one rock tone per cliff: the face piece decides; boulders match it (the palette's same-tone boulder role when
          // the boulder role has none), and keep their own tone only when the palette has no piece of that tone
          const tone = cliffKinds(w, theme).tone;
          if (tone !== undefined) {
            const same = pool.filter((u) => u.weight > 0 && u.tone === tone);
            if (same.length > 0) pool = same;
            else if (f.type === "cliff_crest") {
              const alt = toneBoulders(w, theme, tone);
              if (alt.length > 0) pool = [...alt];
            }
          }
        }
        // generator 3: the loose rock within 3 cells of a cliff follows the cliff's tone (untagged pieces are unknown: kept)
        if (gen.cliffToneRule && CLIFF_DRESSING.has(f.type) && nearCliff(w, f.at[0], f.at[1])) {
          const tone = cliffKinds(w, theme).tone;
          const tagged = pool.filter((u) => u.weight > 0 && u.tone !== undefined);
          if (tone !== undefined && tagged.length > 0) {
            if (tagged.some((u) => u.tone === tone)) pool = pool.filter((u) => u.tone === undefined || u.tone === tone);
            else {
              const alt = toneBoulders(w, theme, tone);
              if (alt.length > 0) pool = [...pool.filter((u) => u.tone === undefined), ...alt];
            }
          }
        }
        // generator 3: a wall block (a tile, minCorner) is not a natural standing piece: a cave's stone columns are
        // stalagmites, never a row of Cave Wall stubs that read as a brick maze
        if (gen.naturalStanding && NATURAL_STANDING.has(f.type)) {
          const notTiles = pool.filter((u) => u.geom.originAt !== "minCorner");
          if (notTiles.length > 0) pool = notTiles;
        }
        // generator 3: a stall's kind is the goods it sells; kinds that stand on the bare table share its variant
        const wantVariant =
          gen.stallsAndLines && f.type === "stall" && f.variant !== undefined
            ? stallPieceOf(f.variant)
            : f.variant;
        if (wantVariant !== undefined) {
          const m = res.variants.filter((u) => u.variant === wantVariant);
          if (m.length) pool = m;
          else
            addDiag({
              severity: "info",
              code: "variant_unknown",
              message: `Variant "${f.variant}" not in "${res.role}"; default used`,
              levelId: L.id,
              role: roleName,
              elementId: f.id,
            });
        }
        v = pick(pool, `${L.id}:feature:${f.id}`);
        // generator 3: a stall made of 1x1 tiles (fruit, vegetables, spices) is one tile in each of its two cells
        if (
          v &&
          gen.stallsAndLines &&
          f.type === "stall" &&
          v.footprint[0] * v.footprint[1] === 1 &&
          f.size[0] * f.size[1] === 2
        ) {
          const fct = facingOf(v, "feature", resolvedRole);
          const wantPlan = rotateDir("S", Math.round(f.rot / 90));
          const degRaw = frame.stepsToFace(fct.front ?? "N", frame.worldSide(wantPlan)) * 15 + v.rot;
          const degT = (((Math.round(degRaw / 90) % 4) + 4) % 4) * 90;
          for (let yy = f.at[1]; yy < f.at[1] + f.size[1]; yy++)
            for (let xx = f.at[0]; xx < f.at[0] + f.size[0]; xx++) {
              const vt = pick(pool, `${L.id}:feature:${f.id}:${xx}:${yy}`) ?? v;
              const m = frame.rectMin(xx, yy, 1, 1);
              emit(vt, "feature", m.x, f.baseHeight, m.z, degT, { cell: [xx, yy], elementId: f.id });
            }
          return;
        }
        if (v && RUN_MIX.has(f.type)) {
          const near = (runPicks.get(res.role) ?? []).filter(
            (q) =>
              (q.y === f.at[1] && Math.abs(q.x - f.at[0]) <= 3) ||
              (q.x === f.at[0] && Math.abs(q.y - f.at[1]) <= 3),
          );
          const same = near.filter((q) => q.uuid === v?.uuid).length;
          const others = pool.filter((u) => u.weight > 0 && u.uuid !== v?.uuid);
          if (same >= 1 && others.length > 0) v = pick(others, `${L.id}:feature:${f.id}:mix`) ?? v;
          const l = runPicks.get(res.role) ?? [];
          l.push({ x: f.at[0], y: f.at[1], uuid: v.uuid });
          runPicks.set(res.role, l);
        }
        // a vehicle is the thing asked for or nothing (owner's model test, 2026-11-20: a 4×2 "Stalled bus" became a
        // taxi). Its length must be close to the feature's long side; a label naming a kind the asset is not (a
        // van that becomes a taxi of the same size) is placed with a note.
        if (v && f.type === "vehicle") {
          const featLong = Math.max(f.size[0], f.size[1]);
          const assetLong = Math.max(v.geom.size.x, v.geom.size.z);
          const label = (f.label ?? "").toLowerCase();
          const kind =
            /\b(bus|coach|van|truck|lorry|tram|cart|wagon|carriage|car|taxi|cab|jeep|pickup)\b/.exec(
              label,
            )?.[1];
          const CARS = new Set(["car", "taxi", "cab"]);
          const nameLc = (v.name ?? "").toLowerCase();
          const sameKind =
            kind === undefined ||
            nameLc.includes(kind) ||
            (CARS.has(kind) && /\b(car|taxi|cab)/.test(nameLc));
          if (Math.abs(featLong - assetLong) > 1.2) {
            addDiag({
              severity: "info",
              code: "custom_unresolved",
              message: `Vehicle "${f.label ?? f.id}" (${f.size[0]}×${f.size[1]}): the theme's vehicles (${v.name ?? v.uuid}, ${assetLong.toFixed(1)} long) are not that size; nothing was placed`,
              levelId: L.id,
              elementId: f.id,
            });
            return;
          }
          if (!sameKind)
            addDiag({
              severity: "info",
              code: "custom_resolved",
              message: `Vehicle "${f.label ?? f.id}": the theme has no ${kind}; "${v.name ?? v.uuid}" stands in`,
              levelId: L.id,
              elementId: f.id,
            });
        }
      }
      if (!v) return;
      const fp = f.size;
      const facing = facingOf(v, "feature", resolvedRole);
      let deg: number;
      if (rule === "inherit" || rule === "random15") {
        const fine = rule === "inherit" ? f.rotFine : (h32(`${seed}:${f.id}:r15`) % 24) * 15;
        deg = frame.planDegreesToWorld(fine) + v.rot;
      } else if (rule === "random90") {
        deg = frame.stepsForQuarters(h32(`${seed}:${f.id}:r90`) % 4) * 15 + v.rot;
      } else if (rule === "fixed") {
        deg = v.rot;
      } else if (f.wall) {
        deg = frame.stepsToFace(facing.mountsOn ?? "S", frame.worldSide(f.wall)) * 15 + v.rot;
      } else {
        let wantPlan = rotateDir("S", Math.round(f.rot / 90));
        // "Against the wall" furniture never faces into a wall: turn it to face into the room.
        if (wallFacing.has(f.type) && rectSideWalled(f.at[0], f.at[1], f.size[0], f.size[1], wantPlan)) {
          const square = f.size[0] === f.size[1];
          const alt = [
            opposite(wantPlan),
            ...(square ? [rotateDir(wantPlan, 1), rotateDir(wantPlan, 3)] : []),
          ].find((s) => !rectSideWalled(f.at[0], f.at[1], f.size[0], f.size[1], s));
          if (alt) wantPlan = alt;
        }
        // asset front at rot 0 defaults to N (+z), verified on three assets (orientation.json defaultFacing.feature)
        deg = frame.stepsToFace(facing.front ?? "N", frame.worldSide(wantPlan)) * 15 + v.rot;
      }
      deg = ((deg % 360) + 360) % 360;
      // a long asset lies along a long feature (city street, 2026-11-20: a taxi on a 3×2 "parked car" stood across
      // the road): when a quarter turn fits the asset's footprint to the feature's better, take it. Wall pieces keep
      // their mounting side.
      if (!f.wall && fp[0] !== fp[1]) {
        const q = Math.round(deg / 90) % 2 === 1;
        const [aw, ah] = q ? [v.footprint[1], v.footprint[0]] : [v.footprint[0], v.footprint[1]];
        const miss = (w: number, h: number): number => Math.abs(w - fp[0]) + Math.abs(h - fp[1]);
        if (miss(ah, aw) < miss(aw, ah)) deg = (deg + 90) % 360;
      }
      // tiles (and tile assemblies) stay on quarter turns: a 15° tile would not sit on the grid
      if (v.geom.originAt === "minCorner") deg = (Math.round(deg / 90) % 4) * 90;
      // ResolvedFeature.baseHeight is ABSOLUTE: elevation + floor thickness + cell height + lift (resolver featureBase).
      const y = f.baseHeight;
      const src: Placement["source"] = { cell: [f.at[0], f.at[1]], elementId: f.id };
      // footprint check (quarter turns swap the asset's footprint)
      const quarter = Math.round(deg / 90) % 2 === 1;
      const afp = quarter ? [v.footprint[1], v.footprint[0]] : [v.footprint[0], v.footprint[1]];
      if (afp[0] !== fp[0] || afp[1] !== fp[1]) {
        addDiag({
          severity: "info",
          code: "footprint_mismatch",
          message: `"${v.name ?? v.uuid}" covers ${afp[0]}×${afp[1]} cells, feature is ${fp[0]}×${fp[1]}; centred on the feature`,
          levelId: L.id,
          role: roleName,
        });
      }
      if (f.wall) {
        // back of the asset on the mounting plane: the edge line, or the face of a strip hosted in this cell
        const s = f.wall;
        const px = s === "W" ? f.at[0] : s === "E" ? f.at[0] + 1 : f.at[0] + 0.5;
        const py = s === "N" ? f.at[1] : s === "S" ? f.at[1] + 1 : f.at[1] + 0.5;
        const grid = s === "N" || s === "S" ? L.hEdges : L.vEdges;
        const e =
          s === "N"
            ? V.hEdge(f.at[0], f.at[1])
            : s === "S"
              ? V.hEdge(f.at[0], f.at[1] + 1)
              : s === "W"
                ? V.vEdge(f.at[0], f.at[1])
                : V.vEdge(f.at[0] + 1, f.at[1]);
        const hostedHere =
          e >= 0 &&
          (grid.host[e] ?? 1) === (s === "N" || s === "W" ? 1 : 0) &&
          (grid.kind[e] === EDGE.WALL || grid.kind[e] === EDGE.OPENING);
        // centred props (banners, paintings) are pushed off the wall by half their depth so the back touches it;
        // "other"-origin props (wall torch, wall lever) are authored with the origin on their back face.
        const mountAxisDepth =
          facing.mountsOn === "E" || facing.mountsOn === "W" ? v.geom.size.x : v.geom.size.z;
        const inward = (hostedHere ? 0.5 : 0) + (v.geom.originAt === "center" ? mountAxisDepth / 2 : 0);
        const ix = s === "W" ? inward : s === "E" ? -inward : 0;
        const iy = s === "N" ? inward : s === "S" ? -inward : 0;
        const p = frame.point(px + ix, py + iy);
        emit(v, "feature", p.x, y, p.z, deg, src);
        return;
      }
      // landmarks must give the map a skyline
      if (f.type === "landmark" || f.type === "tree_large" || f.type === "statue_large") {
        const top = Math.max(
          v.geom.size.y,
          ...(v.parts ?? []).map((q) => (q.offset?.y ?? 0) + q.geom.size.y),
        );
        if (top < 3 - EPS)
          addDiag({
            severity: "info",
            code: "landmark_short",
            message: `"${v.name ?? v.uuid}" for ${f.type} ${f.id} is only ${Math.round(top * 10) / 10} tiles tall; a landmark should stand 3 or more (use an assembly or a taller asset)`,
            levelId: L.id,
            role: roleName,
            elementId: f.id,
          });
      }
      if (v.geom.originAt === "minCorner") {
        const m = frame.rectMin(f.at[0], f.at[1], fp[0], fp[1]);
        emit(v, "feature", m.x, y, m.z, deg, src);
      } else {
        // generator 3: a sub-cell shift (ResolvedFeature.offset; centred pieces only, tiles stay on the grid)
        const c = frame.point(
          f.at[0] + fp[0] / 2 + (f.offset?.[0] ?? 0),
          f.at[1] + fp[1] / 2 + (f.offset?.[1] ?? 0),
        );
        const off = rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
        emit(v, "feature", c.x - off.x, y, c.z - off.z, deg, src);
      }
      // assembly pieces: same anchor and rotation, each moved by its own offset (palette `parts`)
      const centre = frame.point(
        f.at[0] + fp[0] / 2 + (v.geom.originAt === "minCorner" ? 0 : (f.offset?.[0] ?? 0)),
        f.at[1] + fp[1] / 2 + (v.geom.originAt === "minCorner" ? 0 : (f.offset?.[1] ?? 0)),
      );
      for (const part of v.parts ?? []) {
        const pv: ResolvedVariant = {
          ...v,
          uuid: part.asset,
          wanted: part.asset,
          geom: part.geom,
          name: part.name ?? v.name,
          offset: { x: 0, y: 0, z: 0 },
          rot: v.rot,
        };
        delete pv.parts;
        const o = rotateXZ(part.offset?.x ?? 0, part.offset?.z ?? 0, deg * frame.o.rotSense);
        const py = y + v.offset.y + (part.offset?.y ?? 0);
        if (part.geom.originAt === "minCorner") {
          const swap = Math.round(deg / 90) % 2 === 1;
          const hx = (swap ? part.geom.size.z : part.geom.size.x) / 2;
          const hz = (swap ? part.geom.size.x : part.geom.size.z) / 2;
          emit(pv, "feature", centre.x + o.x - hx, py, centre.z + o.z - hz, deg, src);
        } else {
          const off = rotateXZ(part.geom.boundsCenter.x, part.geom.boundsCenter.z, deg * frame.o.rotSense);
          emit(pv, "feature", centre.x + o.x - off.x, py, centre.z + o.z - off.z, deg, src);
        }
      }
    }

    // ── buildings and enclosures ──
    if (L.structures?.length)
      realizeStructures({
        L,
        frame,
        seed,
        lookup: (theme, roles, filter, quiet) => lookup(L.id, theme, roles, filter, quiet),
        pick,
        facingOf,
        emit,
        groundTop: (x, y) => {
          const c = V.cell(x, y);
          return c.open ? topOf(c) : elev + 0.5;
        },
        info: (code, message, role) => {
          addDiag({
            severity: "info",
            code: code as CompileDiagnostic["code"],
            message,
            levelId: L.id,
            ...(role ? { role } : {}),
          });
        },
      });
    finishLevel(w, out);
  }

  return finishRealize(ctx, out);
}
