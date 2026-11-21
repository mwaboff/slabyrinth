/**
 * Preview fidelity of materials and wall styles: what the 2D map shows but the theme builds with something else.
 *
 * Emits `verify_material_substituted`, per level: first one per (theme, floor material) the theme substitutes
 * (warning for lava and water, else info), then one per (theme, wall style) (info). Water is TaleSpire's board water
 * level over a bed (`bed.*`), so no water tile is expected and water is never noted.
 */
import type { CompileDiagnosticCode } from "../../contracts/compiler";
import type { ResolvedLevel } from "../../contracts/resolved";
import { EDGE } from "../../contracts/resolved";
import { THEME_WALL_STYLE } from "../../gen/wallStyles";
import { wallRole } from "../../palette/roles";
import type { LevelGrid } from "../../resolve/levelGrid";
import type { VerifyCtx } from "./context";

/** The codes this file emits (VERIFY_CODES is the union of every check's list). */
export const FIDELITY_CODES = [
  "verify_material_substituted",
] as const satisfies readonly CompileDiagnosticCode[];

export function checkMaterialFidelity(ctx: VerifyCtx): void {
  for (const L of ctx.levels) {
    const g = ctx.grids.get(L.id);
    if (!g) continue;
    noteFloorMaterials(ctx, L, g);
    noteWallStyles(ctx, L, g);
  }
}

/** Floor materials (open floor cells, then the ground under bridges) the theme builds with another floor role. */
function noteFloorMaterials(ctx: VerifyCtx, L: ResolvedLevel, g: LevelGrid): void {
  const mats = new Map<string, { theme: string; material: string; n: number; first: [number, number] }>();
  const note = (theme: string, material: string, x: number, y: number): void => {
    const k = `${theme}|${material}`;
    const e = mats.get(k);
    if (e) e.n++;
    else mats.set(k, { theme, material, n: 1, first: [x, y] });
  };
  for (let ly = 0; ly < g.h; ly++)
    for (let lx = 0; lx < g.w; lx++) {
      const c = g.cell(L.bounds.x + lx, L.bounds.y + ly);
      if (c.floor && c.material) note(c.theme, c.material, L.bounds.x + lx, L.bounds.y + ly);
    }
  for (const b of L.bridges ?? [])
    b.cells.forEach((c, j) => {
      const m = b.underMaterial[j];
      if (m && g.inBounds(c[0], c[1])) note(g.cell(c[0], c[1]).theme, m, c[0], c[1]);
    });
  for (const e of mats.values()) {
    if (e.material.startsWith("water")) continue;
    const want = `floor.${e.material}`;
    const res = ctx.resolveRole(e.theme, want).resolution;
    if (!res || res.role === want) continue;
    const liquid = e.material === "lava" || e.material.startsWith("water");
    const asset = res.variants[0]?.name;
    ctx.report.add({
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
}

/**
 * Wall styles the theme builds with another wall role, counted in edge index order (h edges, then v edges). Building
 * shells are built from facade.<style> roles (compile/structure.ts), not wall.<style>, so claimed edges are left out.
 * The theme asked is the face's (switch `wallNoteInFaceTheme`); released generators asked the level's first theme.
 */
function noteWallStyles(ctx: VerifyCtx, L: ResolvedLevel, g: LevelGrid): void {
  const styles = new Map<string, { theme: string; style: string; n: number }>();
  const faces = ctx.walls.get(L.id)?.faces;
  const inFaceTheme = ctx.profile.wallNoteInFaceTheme;
  for (const orient of ["h", "v"] as const)
    for (let e = 0; e < g.edges(orient).kind.length; e++) {
      const face = faces?.at(orient, e);
      if (!face || face.kind !== EDGE.WALL || face.claimed) continue;
      const theme = inFaceTheme ? face.theme : (L.themes[0] ?? ctx.facts.roles.defaultTheme);
      const k = `${theme}|${face.style}`;
      const x = styles.get(k);
      if (x) x.n++;
      else styles.set(k, { theme, style: face.style, n: 1 });
    }
  for (const st of styles.values()) {
    const want = wallRole(st.style);
    const res = ctx.resolveRole(st.theme, want).resolution;
    if (!res || res.role === want || st.style === THEME_WALL_STYLE) continue;
    ctx.report.add({
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
