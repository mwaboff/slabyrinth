/**
 * `render rests`: measures the bundled palettes' pieces from the game's meshes and writes core's generated tables:
 *   - palette/restHeights.ts: where a thing set on each furniture and stall piece rests (its real top surface, scene3d
 *     `readRestSurface`);
 *   - palette/restGrids.ts: that rest height cell by cell over the piece's top (scene3d `readRestGrid`: a chest's lid
 *     holds things only along its crest, an anvil's face stands over its horn);
 *   - palette/hangGrids.ts: the underside of each piece things hang under, cell by cell (scene3d `readHangGrid`: a
 *     sloping canopy cloth's low side, a thick canopy's underside);
 *   - palette/coverHoles.ts: the largest open patch of each floor piece's top (scene3d `readTopCover`: a rounded-corner
 *     tile leaves a wedge of its cell open).
 * Numbers only, by asset id, for pieces the palettes already name (core `restPieces`, `hangPieces`, `coverPieces`),
 * each with the collider it was read against and its mesh's identity (core palette/measured.ts applies an entry only
 * while the palette's collider is that one); nothing else read from the game is written. Each table's header states a
 * hash of its body, which a core test recomputes, so a hand edit fails the tests. Re-run it after the palette import
 * (the import runs it when TaleSpire is installed), so new and reshaped palette pieces get measured.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TABLE_HASH_PREFIX,
  coverPieces,
  hangPieces,
  loadPalettes,
  restPieces,
  tableBodyHash,
  type RestPiece,
} from "@slabyrinth/core";
import {
  meshIdentity,
  readHangGrid,
  readRestGrid,
  readRestSurface,
  readTopCover,
  type MeshData,
  type PieceGeom,
  type RestGrid,
} from "@slabyrinth/scene3d";
import { flag, type Args } from "./args";
import { REPO_ROOT } from "./inputs";
import { openMeshes } from "./meshes";
import type { Io, RenderEnv } from "./render3d";

export const USAGE_RESTS = `usage: npm run render -- rests [--install <folder>] [--dry]
  measures where things set on each piece of the bundled palettes' feature.* and stall.* roles rest (one height and a
  grid over its top), the underside of each stall canopy piece and how each floor piece covers its cells, from the
  TaleSpire install (read-only), and writes packages/core/src/palette/{restHeights,restGrids,hangGrids,coverHoles}.ts
  (--dry: print the rest heights only)`;

const PALETTE_DIR = join(REPO_ROOT, "packages", "core", "src", "palette");
export const RESTS_FILE = join(PALETTE_DIR, "restHeights.ts");
export const REST_GRIDS_FILE = join(PALETTE_DIR, "restGrids.ts");
export const HANG_GRIDS_FILE = join(PALETTE_DIR, "hangGrids.ts");
export const COVER_FILE = join(PALETTE_DIR, "coverHoles.ts");

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
/** A piece's name as a table string: no line breaks, comment ends, quotes or backslashes. */
const clean = (name: string): string => name.replace(/[\r\n*/"\\]/g, " ").trim();

/** What a reading was taken against: the collider (the install's, the reading's frame) and the mesh's identity. */
export interface ReadAgainst {
  readonly geom: PieceGeom;
  readonly mesh: string;
}

/** One measured piece: the palette's piece, what it was read against, and the reading's fields as table text. */
export interface TableEntry {
  readonly piece: RestPiece;
  readonly against: ReadAgainst;
  /** The reading's own fields, in order (`rest: 0.75`, `grid: "2x2:…"`), as TypeScript source. */
  readonly fields: readonly string[];
}

/** One generated table's declaration: its constant, the entry type it is typed by and what it is. */
interface TableSpec {
  readonly constName: string;
  readonly type: "MeasuredRest" | "MeasuredGrid" | "MeasuredHole";
  readonly unreadName: string;
  /** The header's description lines (each starting " * "). */
  readonly about: readonly string[];
  readonly unreadAbout: string;
}

/** A generated table's text: its header (with the body's hash), the entries and the unread list. */
export function tableFileText(
  spec: TableSpec,
  entries: readonly TableEntry[],
  unread: readonly RestPiece[],
): string {
  const body = [
    `import type { ${spec.type} } from "./measured";`,
    "",
    `export const ${spec.constName}: Readonly<Record<string, ${spec.type}>> = {`,
    ...entries.flatMap(({ piece, against, fields }) => [
      `  "${piece.asset}": {`,
      `    name: "${clean(piece.name)}",`,
      ...fields.map((f) => `    ${f},`),
      `    size: [${[against.geom.size.x, against.geom.size.y, against.geom.size.z].map((v) => String(r3(v))).join(", ")}],`,
      `    mesh: "${against.mesh}",`,
      "  },",
    ]),
    "};",
    "",
    `/** ${spec.unreadAbout} */`,
    ...(unread.length === 0
      ? [`export const ${spec.unreadName}: readonly string[] = [];`]
      : [
          `export const ${spec.unreadName}: readonly string[] = [`,
          ...unread.map((p) => `  "${p.asset}", // ${clean(p.name)}`),
          "];",
        ]),
    "",
  ].join("\n");
  return [
    "/**",
    " * GENERATED by `npm run render -- rests` (packages/render-cli/src/rests.ts) from the TaleSpire install's meshes; do",
    " * not edit by hand. Re-run it after the palette import (which runs it when TaleSpire is installed).",
    " *",
    ...spec.about,
    " * Each entry records the collider it was read against and its mesh's identity: palette/measured.ts applies it only",
    " * while the palette's collider is that one.",
    " *",
    `${TABLE_HASH_PREFIX}${tableBodyHash(body)} (palette/measured.ts checkTableHash: a core test recomputes it).`,
    " */",
    body,
  ].join("\n");
}

const RESTS: TableSpec = {
  constName: "MEASURED_RESTS",
  type: "MeasuredRest",
  unreadName: "UNREAD_RESTS",
  about: [
    " * Where a thing set on a piece rests: the height of the piece's real top surface above its collider's bottom, in",
    " * tiles (the frame of the palette's `geom.size.y`), for every piece of the bundled palettes' feature.* and stall.*",
    " * roles, by asset id. palette/restSurface.ts reads it; a piece not listed rests at its collider's top.",
  ],
  unreadAbout:
    "Pieces the measuring could not read (no mesh in the install): they rest at their collider's top.",
};

const REST_GRIDS: TableSpec = {
  constName: "MEASURED_REST_GRIDS",
  type: "MeasuredGrid",
  unreadName: "UNREAD_REST_GRIDS",
  about: [
    " * Where a thing set on a piece rests, cell by cell over its top: for every piece of the bundled palettes' feature.*",
    " * and stall.* roles, by asset id, \"<nx>x<nz>:\" and then each cell's rest height above the collider's bottom in",
    " * hundredths of a tile, row by row from the outline's min z, each from its min x, in the piece's own frame (unturned),",
    ' * "-" where the top cannot hold a thing (a slope, a rim, a carving, nothing there). palette/restGrid.ts reads it; a',
    " * piece not listed rests at its one measured height (palette/restHeights.ts) everywhere.",
  ],
  unreadAbout: "Pieces the measuring could not read (no mesh in the install).",
};

const HANG_GRIDS: TableSpec = {
  constName: "HANG_GRIDS",
  type: "MeasuredGrid",
  unreadName: "UNREAD_HANG_GRIDS",
  about: [
    " * Where a thing hung under a cover meets it, cell by cell over its outline: for every piece of the bundled palettes'",
    ' * roles things hang under (palette/restGrid.ts HANG_ROLE_PREFIXES), by asset id, "<nx>x<nz>:" and then each cell\'s',
    " * lowest point seen from below, above the collider's bottom in hundredths of a tile, in the grid order of",
    ' * palette/restGrids.ts, "-" where the cover does not reach over the cell. palette/restGrid.ts hangGridOf reads it; a',
    " * piece not listed hangs things from its box's underside.",
  ],
  unreadAbout: "Pieces the measuring could not read (no mesh in the install).",
};

const HOLES: TableSpec = {
  constName: "MEASURED_HOLES",
  type: "MeasuredHole",
  unreadName: "UNREAD_HOLES",
  about: [
    " * How each floor piece covers its cells seen from above: the largest open patch of its outline in tiles² (0 for a",
    " * whole tile), for every piece of the bundled palettes' floor.*, fill.*, step.* and bed.* roles, by asset id.",
    " * palette/topCover.ts reads it; a piece not listed counts as whole.",
  ],
  unreadAbout: "Pieces the measuring could not read (no mesh in the install): they count as whole.",
};

/** A rest grid as core's table spells it: "<nx>x<nz>:" then the heights in hundredths, row by row, "-" for none. */
export function restGridText(g: RestGrid): string {
  const h = g.heights.map((v) => (v === null ? "-" : String(Math.round(v * 100))));
  return `${String(g.nx)}x${String(g.nz)}:${h.join(" ")}`;
}

/** The generated rest height table's text. */
export const restsFileText = (
  measured: ReadonlyArray<{ piece: RestPiece; against: ReadAgainst; rest: number }>,
  unread: readonly RestPiece[],
): string =>
  tableFileText(
    RESTS,
    measured.map((m) => ({ ...m, fields: [`rest: ${String(r3(m.rest))}`] })),
    unread,
  );

/** The generated rest grid table's text. */
export const restGridsFileText = (
  measured: ReadonlyArray<{ piece: RestPiece; against: ReadAgainst; grid: RestGrid }>,
  unread: readonly RestPiece[],
): string =>
  tableFileText(
    REST_GRIDS,
    measured.map((m) => ({ ...m, fields: [`grid: "${restGridText(m.grid)}"`] })),
    unread,
  );

/** The generated underside grid table's text. */
export const hangGridsFileText = (
  measured: ReadonlyArray<{ piece: RestPiece; against: ReadAgainst; grid: RestGrid }>,
  unread: readonly RestPiece[],
): string =>
  tableFileText(
    HANG_GRIDS,
    measured.map((m) => ({ ...m, fields: [`grid: "${restGridText(m.grid)}"`] })),
    unread,
  );

/** The generated cover table's text. */
export const coverFileText = (
  measured: ReadonlyArray<{ piece: RestPiece; against: ReadAgainst; hole: number }>,
  unread: readonly RestPiece[],
): string =>
  tableFileText(
    HOLES,
    measured.map((m) => ({ ...m, fields: [`hole: ${String(r3(m.hole))}`] })),
    unread,
  );

export async function renderRests(a: Args, io: Io, env: RenderEnv): Promise<number> {
  const meshes = await openMeshes({
    boxes: false,
    installFlag: flag(a, "install"),
    appData: null,
    ...(env.locate ? { locate: env.locate } : {}),
    log: (s) => {
      io.err(s);
    },
  });
  if (!meshes.install) {
    io.err(`rests: ${meshes.note} Nothing was measured; the tables are unchanged.`);
    return 1;
  }
  const { palettes } = loadPalettes();
  const pieces = restPieces(palettes);
  const covers = hangPieces(palettes);
  const floors = coverPieces(palettes);
  const looked = await meshes.source.load([
    ...new Set([...pieces, ...covers, ...floors].map((p) => p.asset)),
  ]);
  // the install's collider is the frame each reading is in, so it is the one the entry records
  const meshOf = (p: RestPiece): { mesh: MeshData; against: ReadAgainst } | null => {
    const m = looked.get(p.asset);
    return m?.kind === "mesh"
      ? { mesh: m.mesh, against: { geom: m.geom ?? p.geom, mesh: meshIdentity(m.mesh) } }
      : null;
  };
  const measured: Array<{ piece: RestPiece; against: ReadAgainst; rest: number }> = [];
  const grids: Array<{ piece: RestPiece; against: ReadAgainst; grid: RestGrid }> = [];
  const unread: RestPiece[] = [];
  const dry = a.flags.has("dry");
  for (const piece of pieces) {
    const m = meshOf(piece);
    const reading = m ? readRestSurface(m.mesh, m.against.geom) : null;
    if (m && reading) {
      measured.push({ piece, against: m.against, rest: reading.rest });
      grids.push({ piece, against: m.against, grid: readRestGrid(m.mesh, m.against.geom) });
    } else unread.push(piece);
    if (dry)
      io.out(
        `${piece.name.padEnd(40)} box ${piece.geom.size.y.toFixed(3)} rest ${reading ? reading.rest.toFixed(3) : "-"} share ${reading ? reading.share.toFixed(2) : "-"}`,
      );
  }
  const hangs: Array<{ piece: RestPiece; against: ReadAgainst; grid: RestGrid }> = [];
  const hangUnread: RestPiece[] = [];
  for (const piece of covers) {
    const m = meshOf(piece);
    if (m) hangs.push({ piece, against: m.against, grid: readHangGrid(m.mesh, m.against.geom) });
    else hangUnread.push(piece);
  }
  const holes: Array<{ piece: RestPiece; against: ReadAgainst; hole: number }> = [];
  const coverUnread: RestPiece[] = [];
  for (const piece of floors) {
    const m = meshOf(piece);
    const cover = m ? readTopCover(m.mesh, m.against.geom) : null;
    if (m && cover) holes.push({ piece, against: m.against, hole: cover.hole });
    else coverUnread.push(piece);
  }
  if (dry) return 0;
  writeFileSync(RESTS_FILE, restsFileText(measured, unread));
  writeFileSync(REST_GRIDS_FILE, restGridsFileText(grids, unread));
  writeFileSync(HANG_GRIDS_FILE, hangGridsFileText(hangs, hangUnread));
  writeFileSync(COVER_FILE, coverFileText(holes, coverUnread));
  io.out(
    `rests: measured ${String(measured.length)} pieces (${String(unread.length)} unread), ${String(hangs.length)} cover undersides (${String(hangUnread.length)} unread) and ${String(holes.length)} floor pieces (${String(coverUnread.length)} unread); wrote ${RESTS_FILE}, ${REST_GRIDS_FILE}, ${HANG_GRIDS_FILE} and ${COVER_FILE}`,
  );
  return 0;
}
