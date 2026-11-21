/**
 * Realize, solid shell (generator 4): a built interior is carved into a solid mass. planSolidShell runs before the
 * wall runs (its skirt edges join them); layShellCap lays the flat cap and the strips between rooms after them.
 * The shell itself is planned by compile/shell.ts.
 * Reads: the level's cells and structures, `claimed`, the palette's cap and floor roles. Writes: `roughMap`, `shell`,
 * `capRes`, `capVariants`, `shellEdges` (planSolidShell); fill placements (layShellCap).
 */
import { CELL } from "../../contracts/resolved";
import { roughCells } from "../../resolve/wallTops";
import { h32 } from "../geometry";
import { SHELL, planShell } from "../shell";
import type { LevelWork } from "./work";

// generator 4: a built interior is carved into a solid mass: a flat cap on the solid cells round the rooms, closed
// on its outer edge by a skirt of the level's wall style (compile/shell.ts). The cap piece comes first: with no
// cap tile in any palette the shell is left out whole.
export function planSolidShell(w: LevelWork): void {
  const { L, V, claimed, shellEdges } = w;
  const { resolved, seed, gen, defaultTheme, lookup } = w.ctx;
  const carvedLevel = !L.structures?.length && L.cells.state.some((s) => s === CELL.SOLID);
  // ... and only a rough interior gets broken wall tops (a kept-up timber inn keeps clean walls)
  w.roughMap = gen.interiorWallTops && carvedLevel ? roughCells(L) : null;
  let shell = gen.solidShell && carvedLevel
    ? planShell(resolved, L, seed, (o, e) => claimed.edges.has(`${o}${e}`), defaultTheme)
    : null;
  const capRes = shell ? lookup(L.id, shell.theme, ["cap.solid"], undefined, true) : null;
  const capVariants = (capRes?.variants ?? []).filter((v) => v.weight > 0 && v.footprint[0] === v.footprint[1]);
  if (shell && capVariants.length === 0) shell = shell.strips.length > 0 ? { ...shell, cells: new Map(), edges: [] } : null;
  const capThick = capVariants.length > 0 ? Math.min(...capVariants.map((v) => v.geom.size.y)) : 0.5;
  w.shell = shell;
  w.capRes = capRes;
  w.capVariants = capVariants;
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
}

export function layShellCap(w: LevelWork): void {
  const { L, shell, capRes, capVariants, emit } = w;
  const { seed, frame, lookup, pick } = w.ctx;
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
}
