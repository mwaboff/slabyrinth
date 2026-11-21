#!/usr/bin/env node
/**
 * slabyrinth CLI — headless seam for scripts and a future Claude Code plugin (architecture §4.7).
 *
 *   slabyrinth validate <plan.json>
 *   slabyrinth ascii <plan.json> [--level <id>]
 *   slabyrinth compile <plan.json> [--out <dir>] [--palettes <dir>] [--orientation <file>] [--catalog <catalog.json>]
 *                      [--fill <0..1>] [--alignment multi-chunk|always|none] [--layout stacked|side_by_side] [--json]
 *                      [--force] (write slabs despite verify errors) [--verbose] (also print info diagnostics)
 *                      [--omit-layer roof] (leave a paste layer out: roof, storey:1 …; repeatable as a comma list)
 *   slabyrinth decode <slab | @file | -> [--catalog <catalog.json>] [--json]
 *   slabyrinth encode <assets.json | -> [--fenced]
 *   slabyrinth catalog [--install <dir>] [--cached <catalog.json>] [--out <catalog.json>] [--json]
 *   slabyrinth calibration [--out <file>]
 *   slabyrinth review <plan.json> [--no-build] [--json] [--palettes <dir>]  (design review: advice, never errors;
 *                      builds the plan so substituted pieces are summarised, unless --no-build)
 *
 * node:* imports are allowed only in src/cli. Exit codes: 0 ok, 1 errors in the input, 2 usage.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  NULL_AVAILABILITY,
  buildCatalogFromInstall,
  createAvailability,
  locateTaleSpire,
} from "../catalog/index";
import type { AssetCatalog, ChunkOptions, PaletteCatalog, SlabAsset } from "../contracts/compiler";
import type { MapPlan } from "../contracts/plan";
import { calibrationAssetsFrom, calibrationSlabAssets, compileResolved, realize } from "../compile/index";
import { loadOrientation, loadPalettes, paletteOptionsFor } from "../palette/index";
import { validatePlan } from "../plan/index";
import { resolvePlan } from "../resolve/index";
import {
  decodeDetailed,
  encode,
  fenceSlab,
  normalizeGuid,
  slabCodec,
  toScaled,
  degreesToRot,
} from "../slab/index";
import { asciiView } from "../text/index";
import { designReviewText, reviewDesign } from "../review/index";
import { hostSteamHints, nodeReadonlyFs } from "./nodeFs";

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  readStdin: () => string;
}

const defaultIo: CliIo = {
  out: (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"),
  err: (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"),
  readStdin: () => readFileSync(0, "utf8"),
};

class UsageError extends Error {}

interface Args {
  _: string[];
  flags: Record<string, string | true>;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? "";
    if (t.startsWith("--")) {
      const [k, v] = t.slice(2).split("=", 2) as [string, string?];
      const next = argv[i + 1];
      if (v !== undefined) a.flags[k] = v;
      else if (
        next !== undefined &&
        !next.startsWith("--") &&
        !["json", "fenced", "check", "force", "verbose", "no-build"].includes(k)
      ) {
        a.flags[k] = next;
        i++;
      } else a.flags[k] = true;
    } else a._.push(t);
  }
  return a;
}
const flag = (a: Args, k: string): string | undefined =>
  typeof a.flags[k] === "string" ? a.flags[k] : undefined;

function readJson(path: string, io: CliIo): unknown {
  const text = path === "-" ? io.readStdin() : readFileSync(path, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
}

function palettesFrom(a: Args, io: CliIo): PaletteCatalog {
  const user: Array<{ source: string; data: unknown }> = [];
  const dir = flag(a, "palettes");
  if (dir)
    for (const f of readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort())
      user.push({ source: f, data: readJson(join(dir, f), io) });
  const catPath = flag(a, "catalog");
  const availability = catPath
    ? createAvailability(readJson(catPath, io) as AssetCatalog)
    : NULL_AVAILABILITY;
  const cat = loadPalettes({ user, availability });
  for (const i of cat.issues) io.err(`palette ${i.severity}: ${i.source}: ${i.message}`);
  return cat;
}

function cmdValidate(a: Args, io: CliIo): number {
  const path = a._[1];
  if (!path) throw new UsageError("validate <plan.json>");
  const r = validatePlan(readJson(path, io));
  if (a.flags["json"]) io.out(JSON.stringify(r, null, 2));
  else {
    for (const i of r.issues)
      io.out(
        `${i.severity.padEnd(7)} ${i.code}${i.path ? ` ${i.path}` : ""}: ${i.message}${i.hint ? `  (hint: ${i.hint})` : ""}`,
      );
    io.out(r.ok ? `OK (${r.issues.length} non-error issue(s))` : "INVALID");
  }
  return r.ok ? 0 : 1;
}

function cmdAscii(a: Args, io: CliIo): number {
  const path = a._[1];
  if (!path) throw new UsageError("ascii <plan.json> [--level <id>]");
  const plan = readJson(path, io) as MapPlan;
  const resolved = resolvePlan(plan);
  const levels = flag(a, "level") ? [flag(a, "level") ?? ""] : resolved.levels.map((l) => l.id);
  for (const id of levels) {
    if (levels.length > 1) io.out(`── ${id} ──`);
    io.out(asciiView(resolved, id));
  }
  return 0;
}

function cmdCompile(a: Args, io: CliIo): number {
  const path = a._[1];
  if (!path) throw new UsageError("compile <plan.json> [--out <dir>] …");
  const plan = readJson(path, io) as MapPlan;
  const v = validatePlan(plan);
  if (!v.ok) {
    for (const i of v.issues.filter((x) => x.severity === "error")) io.err(`error ${i.code}: ${i.message}`);
    io.err("compile refused: the plan has validation errors");
    return 1;
  }
  const cat = palettesFrom(a, io);
  const oPath = flag(a, "orientation");
  const orientation = loadOrientation(oPath ? readJson(oPath, io) : undefined);
  for (const i of orientation.issues) io.err(`orientation ${i.severity}: ${i.message}`);
  const opts: ChunkOptions & { orientation: typeof orientation.orientation; omitLayers?: string[] } = {
    orientation: orientation.orientation,
  };
  const fill = flag(a, "fill");
  if (fill) opts.fill = Number(fill);
  const al = flag(a, "alignment");
  if (al) opts.alignment = al as NonNullable<ChunkOptions["alignment"]>;
  const omit = flag(a, "omit-layer");
  if (omit)
    opts.omitLayers = omit
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const lay = flag(a, "layout");
  if (lay) opts.levelLayout = lay as NonNullable<ChunkOptions["levelLayout"]>;
  const resolved = resolvePlan(plan, paletteOptionsFor(plan, cat));
  const bundle = compileResolved(resolved, cat, slabCodec, { ...opts, plan });
  const errors = bundle.diagnostics.filter((d) => d.severity === "error");
  const force = a.flags["force"] === true;
  const out = errors.length && !force ? undefined : flag(a, "out");
  if (errors.length && !force && flag(a, "out"))
    io.err(`build has ${errors.length} error(s): nothing written (use --force to write anyway)`);
  if (out) {
    mkdirSync(out, { recursive: true });
    for (const c of bundle.chunks) writeFileSync(join(out, `${c.id}.txt`), c.slab + "\n");
    writeFileSync(
      join(out, "report.json"),
      JSON.stringify(
        { ...bundle, chunks: bundle.chunks.map((c) => ({ ...c, slab: `${c.id}.txt` })) },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(out, "PASTE.md"), bundle.instructions + "\n");
  }
  if (a.flags["json"]) io.out(JSON.stringify(bundle, null, 2));
  else {
    for (const c of bundle.chunks)
      io.out(
        `${c.id.padEnd(14)} ${String(c.assetCount).padStart(6)} assets ${String(c.compressedBytes).padStart(6)} B  ${c.label}${c.hasAlignmentMarkers ? "  [markers]" : ""}`,
      );
    // TaleSpire's water is a board-wide plane the slab cannot carry: always say where to set it
    for (const wl of bundle.waterLevels ?? [])
      io.out(
        `water (${wl.levelId}): raise TaleSpire's water to ${wl.aboveBase} tiles (${wl.aboveBase * 5} ft) above the slab's bottom, anywhere from ${wl.min} to ${wl.max}`,
      );
    const verbose = a.flags["verbose"] === true;
    for (const d of bundle.diagnostics.filter((x) => verbose || x.severity !== "info" || x.repaired)) {
      const where = `${d.levelId ?? ""}${d.cell ? ` (${d.cell[0]},${d.cell[1]})${d.side ? ` ${d.side}` : ""}` : ""}`;
      io.err(
        `${d.severity} ${d.code}${d.role ? ` ${d.role}` : ""}${d.count && d.count > 1 ? ` ×${d.count}` : ""}${where ? ` [${where.trim()}]` : ""}: ${d.message}`,
      );
      if (d.hint) io.err(`    fix: ${d.hint}`);
      if (d.repaired) io.err(`    repaired: ${d.repaired}`);
    }
    io.out(
      `${bundle.stats.totalChunks} chunk(s), ${bundle.stats.totalAssets} assets${out ? ` → ${resolvePath(out)}` : ""}`,
    );
  }
  return errors.length && !force ? 1 : 0;
}

function cmdReview(a: Args, io: CliIo): number {
  const path = a._[1];
  if (!path) throw new UsageError("review <plan.json> [--no-build] [--json]");
  const raw = readJson(path, io) as MapPlan | { plan: MapPlan; format: string };
  const plan = "format" in raw && "plan" in raw ? raw.plan : raw;
  const palettes = palettesFrom(a, io);
  const resolved = resolvePlan(plan, paletteOptionsFor(plan, palettes));
  const noBuild = a.flags["no-build"] === true;
  const diagnostics = noBuild ? [] : compileResolved(resolved, palettes, slabCodec, { plan }).diagnostics;
  // the realized pieces too (the cave rock mass is measured on them)
  const placements = noBuild ? undefined : realize(resolved, palettes, {});
  const notes = reviewDesign(plan, resolved, {
    palettes,
    diagnostics,
    ...(placements ? { placements } : {}),
  });
  if (a.flags["json"]) io.out(JSON.stringify(notes, null, 2));
  else io.out(designReviewText(notes) || "design review: nothing to note");
  return 0;
}

function namesFrom(a: Args, io: CliIo): (uuid: string) => string | null {
  const names = new Map<string, string>();
  for (const p of Object.values(loadPalettes().palettes))
    for (const r of Object.values(p.roles))
      for (const v of r.variants) if (v.name) names.set(v.asset.toLowerCase(), v.name);
  const catPath = flag(a, "catalog");
  const av = catPath ? createAvailability(readJson(catPath, io) as AssetCatalog) : null;
  return (u) => av?.name(u) ?? names.get(u) ?? null;
}

function cmdDecode(a: Args, io: CliIo): number {
  const src = a._[1];
  if (!src) throw new UsageError("decode <slab | @file | ->");
  const text = src === "-" ? io.readStdin() : src.startsWith("@") ? readFileSync(src.slice(1), "utf8") : src;
  const d = decodeDetailed(text);
  if (a.flags["json"]) {
    io.out(
      JSON.stringify(
        {
          version: d.version,
          compressedBytes: d.compressedBytes,
          rawBytes: d.rawBytes,
          layouts: d.layouts,
          assets: d.assets,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const name = namesFrom(a, io);
  io.out(
    `v${d.version}: ${d.layouts.length} layouts, ${d.assets.length} assets, ${d.compressedBytes} B gzip (limit ${slabCodec.limits.maxCompressedBytes}), ${d.rawBytes} B raw`,
  );
  for (const l of d.layouts) {
    io.out(`  ${l.uuid}  ×${String(l.count).padEnd(5)} ${name(l.uuid) ?? "(unknown asset)"}`);
    for (const x of d.assets.filter((q) => q.uuid === l.uuid).slice(0, 8))
      io.out(`      (${x.sx / 100}, ${x.sy / 100}, ${x.sz / 100}) rot ${x.rot * 15}°`);
    if (l.count > 8) io.out(`      … ${l.count - 8} more`);
  }
  return 0;
}

/** Accepts {assets:[{uuid,x,y,z,rot(deg)}]} in tiles, or scaled {sx,sy,sz,rot(0..23)} (e.g. `decode --json` output). */
function cmdEncode(a: Args, io: CliIo): number {
  const src = a._[1];
  if (!src) throw new UsageError("encode <assets.json | ->");
  const doc = readJson(src, io) as
    { assets?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const list = Array.isArray(doc) ? doc : (doc.assets ?? []);
  const assets: SlabAsset[] = list.map((r, i) => {
    const id = r["uuid"] ?? r["asset"];
    const uuid = normalizeGuid(typeof id === "string" ? id : "");
    if (typeof r["sx"] === "number")
      return { uuid, sx: r["sx"], sy: Number(r["sy"]), sz: Number(r["sz"]), rot: Number(r["rot"] ?? 0) };
    if (typeof r["x"] !== "number")
      throw new UsageError(`asset ${i}: needs x,y,z (tiles) or sx,sy,sz (scaled)`);
    return {
      uuid,
      sx: toScaled(r["x"]),
      sy: toScaled(Number(r["y"] ?? 0)),
      sz: toScaled(Number(r["z"] ?? 0)),
      rot: degreesToRot(Number(r["rot"] ?? 0)),
    };
  });
  const r = encode(assets);
  io.out(a.flags["fenced"] ? fenceSlab(r.slab) : r.slab);
  io.err(
    `${assets.length} assets, ${r.compressedBytes} B gzip (limit ${slabCodec.limits.maxCompressedBytes})`,
  );
  return r.compressedBytes > slabCodec.limits.maxCompressedBytes ? 1 : 0;
}

async function cmdCatalog(a: Args, io: CliIo): Promise<number> {
  let install = flag(a, "install");
  if (!install) {
    const loc = await locateTaleSpire(nodeReadonlyFs, hostSteamHints());
    if (!loc.install) {
      io.err("TaleSpire not found. Tried:\n  " + loc.tried.join("\n  ") + "\nUse --install <dir>.");
      return 1;
    }
    install = loc.install.installPath;
    io.err(
      `TaleSpire found at ${install} (${loc.install.how}${loc.install.buildId ? `, build ${loc.install.buildId}` : ""})`,
    );
  }
  const cachedPath = flag(a, "cached");
  let cached: AssetCatalog | null = null;
  if (cachedPath) {
    try {
      cached = readJson(cachedPath, io) as AssetCatalog;
    } catch {
      io.err(`no usable cache at ${cachedPath}`);
    }
  }
  const r = await buildCatalogFromInstall(nodeReadonlyFs, install, {
    cached,
    palettes: loadPalettes().palettes,
  });
  for (const w of r.warnings) io.err(`warning: ${w}`);
  const out = flag(a, "out");
  if (out && r.changed) writeFileSync(out, JSON.stringify(r.catalog, null, 1) + "\n");
  if (a.flags["json"])
    io.out(JSON.stringify({ changed: r.changed, packs: r.packs, report: r.report }, null, 2));
  else {
    for (const p of r.packs)
      io.out(
        `${p.name.padEnd(24)} ${p.packId}  source=${p.source}${p.stale ? " (stale)" : ""}${p.reparsed ? "" : " (unchanged)"}`,
      );
    const rep = r.report;
    io.out(
      `${r.catalog.assets.length} assets (${r.catalog.assets.filter((x) => !x.deprecated).length} not deprecated); ${r.changed ? "rebuilt" : "unchanged (fingerprint match)"}`,
    );
    if (rep.previousGeneratedAt)
      io.out(
        `since ${rep.previousGeneratedAt}: +${rep.added}, −${rep.removed.length}, newly deprecated ${rep.newlyDeprecated.length}, geometry changed ${rep.geometryChanged.length}, palette roles affected ${rep.affectedPaletteRoles.length}`,
      );
    if (out) io.out(r.changed ? `wrote ${resolvePath(out)}` : `cache ${resolvePath(out)} is current`);
  }
  return 0;
}

function cmdCalibration(a: Args, io: CliIo): number {
  const assets = calibrationSlabAssets(calibrationAssetsFrom(loadPalettes()));
  const r = encode(assets);
  const out = flag(a, "out");
  if (out) writeFileSync(out, r.slab);
  else io.out(r.slab);
  io.err(
    `calibration slab: ${assets.length} assets, ${r.compressedBytes} B gzip${out ? ` → ${resolvePath(out)}` : ""}`,
  );
  return 0;
}

const USAGE = `usage: slabyrinth <validate|ascii|compile|review|decode|encode|catalog|calibration> …  (see the header of src/cli/index.ts)`;

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const a = parseArgs(argv);
  try {
    switch (a._[0]) {
      case "validate":
        return cmdValidate(a, io);
      case "ascii":
        return cmdAscii(a, io);
      case "compile":
        return cmdCompile(a, io);
      case "decode":
        return cmdDecode(a, io);
      case "encode":
        return cmdEncode(a, io);
      case "catalog":
        return await cmdCatalog(a, io);
      case "review":
        return cmdReview(a, io);
      case "calibration":
        return cmdCalibration(a, io);
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`usage: slabyrinth ${e.message}`);
      return 2;
    }
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolvePath(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
