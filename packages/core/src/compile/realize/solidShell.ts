/**
 * Realize, solid shell (generator 4, `solidShell`): a built interior is carved into a solid mass. planSolidShell runs
 * before the wall runs (its skirt edges join them); layShellCap lays the flat cap and the strips between rooms after
 * them. The shell itself is planned by compile/shell.ts.
 * Reads: the level's cells and structures, `claimed`, the palette's cap and wall roles and the floor role of a wall's
 * top (palette/wallTop.ts). Writes: the `SolidShellPlan`
 * it returns (read by the wall, cap and rock wall passes); fill placements (layShellCap).
 */
import type { ResolvedVariant, RoleResolution } from "../../palette/resolve";
import { wallTopRoles } from "../../palette/wallTop";
import { h32 } from "../geometry";
import { SHELL, isCarvedLevel, planShell, type Shell } from "../shell";
import type { EdgeCtx } from "./edges";
import type { RealizeLevel } from "./level";

/** The level's solid shell as the later passes read it. */
export interface SolidShellPlan {
  /** The shell, null when the level has none. */
  readonly shell: Shell | null;
  /** The shell's cap role and its square cap pieces. */
  readonly capRes: RoleResolution | null;
  readonly capVariants: readonly ResolvedVariant[];
  /** The shell's skirt edges as wall runs see them, by "<orient><edge index>". */
  readonly skirtEdges: ReadonlyMap<string, EdgeCtx>;
}

const NO_SHELL: SolidShellPlan = { shell: null, capRes: null, capVariants: [], skirtEdges: new Map() };

/**
 * Generator 4 (`solidShell`): a built interior is carved into a solid mass: a flat cap on the solid cells round the
 * rooms, closed on its outer edge by a skirt of the level's wall style (compile/shell.ts). The cap piece comes first:
 * with no cap tile in any palette the shell is left out whole.
 */
export function planSolidShell(lv: RealizeLevel): SolidShellPlan {
  const { L, V, claimed } = lv;
  const { resolved, seed, profile, defaultTheme, lookup } = lv.ctx;
  if (!profile.solidShell || !isCarvedLevel(L)) return NO_SHELL;
  let shell = planShell(resolved, L, seed, (o, e) => claimed.edges.has(`${o}${e}`), defaultTheme);
  const capRes = shell ? lookup(L.id, shell.theme, ["cap.solid"], undefined, true) : null;
  const capVariants = (capRes?.variants ?? []).filter(
    (v) => v.weight > 0 && v.footprint[0] === v.footprint[1],
  );
  if (shell && capVariants.length === 0)
    shell = shell.strips.length > 0 ? { ...shell, cells: new Map(), edges: [] } : null;
  const capThick = capVariants.length > 0 ? Math.min(...capVariants.map((v) => v.geom.size.y)) : 0.5;
  const skirtEdges = new Map<string, EdgeCtx>();
  if (shell)
    for (const se of shell.edges) {
      const e = se.orient === "h" ? V.hEdge(se.x, se.y) : V.vEdge(se.x, se.y);
      if (e < 0) continue;
      skirtEdges.set(`${se.orient}${e}`, {
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
  return { shell, capRes, capVariants, skirtEdges };
}

/**
 * Generator 4: the flat cap of the solid shell, flush with the wall tops, in the palette's biggest square pieces, and
 * the flush strips between tidy rooms. Runs only where planSolidShell planned a shell.
 */
export function layShellCap(lv: RealizeLevel, plan: SolidShellPlan): void {
  const { shell } = plan;
  if (!shell) return;
  if (plan.capRes) layCap(lv, shell, plan.capVariants);
  if (shell.strips.length > 0) layStrips(lv, shell);
}

function layCap(lv: RealizeLevel, shell: Shell, capVariants: readonly ResolvedVariant[]): void {
  const { L, V, emit } = lv;
  const { seed, frame, pick } = lv.ctx;
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
          const cc = shell.cells.get(V.index(c.x + dx, c.y + dy));
          if (!cc || capUsed.has(`${c.x + dx},${c.y + dy}`) || cc.theme !== c.theme || cc.top !== c.top)
            fits = false;
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

// in a tidy interior, a one-cell solid strip between two rooms is closed flush at wall-top height with the top of the
// wall it closes, so two rooms read as sharing one thick wall instead of a trench. The top belongs to the wall, not to
// a room beside it: palette/wallTop.ts asks the palette what the wall, as built, is made of
function layStrips(lv: RealizeLevel, shell: Shell): void {
  const { L, emit } = lv;
  const { frame, lookup, pick, palettes } = lv.ctx;
  for (const s of shell.strips) {
    const wall = lookup(L.id, s.theme, [`wall.${s.style}`], undefined, true);
    const sr = lookup(
      L.id,
      s.theme,
      wallTopRoles(palettes.palettes, s.style, wall),
      { key: "strip1x1", test: (v) => v.footprint[0] === 1 && v.footprint[1] === 1 },
      true,
    );
    const sv = sr
      ? pick(
          sr.variants.filter((v) => v.weight > 0),
          `${L.id}:strip:${s.x}:${s.y}`,
        )
      : undefined;
    if (!sv) continue;
    const m = frame.rectMin(s.x, s.y, 1, 1);
    emit(sv, "fill", m.x, s.top - sv.geom.size.y, m.z, sv.rot, { cell: [s.x, s.y], elementId: "shell" });
  }
}
