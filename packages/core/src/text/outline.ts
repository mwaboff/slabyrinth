/**
 * Outline view for the model (architecture §3.3 item 2): one line per element with every parameter that matters.
 * Lossless for ids, kinds, shapes, keys, links and terrain ops; long texts are truncated to 60 chars with "…"
 * (view_plan json gives the full text). Resolved facts (where an opening landed, route cells, generated counts,
 * link arrivals) follow "->".
 */
import type {
  Area,
  Feature,
  Level,
  LevelId,
  MapPlan,
  PlanIssue,
  Shape,
  TerrainOp,
  Vec2,
} from "../contracts/plan";
import type { ResolvedLevel, ResolvedOpening, ResolvedPlan } from "../contracts/resolved";
import { entryLevelId } from "../resolve/validate";

export interface OutlineOptions {
  version?: number;
  /** Only these levels (links touching them are still listed). */
  levels?: LevelId[];
  /** Issues to list at the end (default: resolved.issues). */
  issues?: readonly PlanIssue[];
  /** Max characters of note text (default 60). */
  noteChars?: number;
}

const n = (v: number): string => String(Math.round(v * 1000) / 1000);
const xy = (p: Vec2): string => `${n(p[0])},${n(p[1])}`;

export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const q = (s: string): string => JSON.stringify(s);

export function formatShape(s: Shape): string {
  switch (s.type) {
    case "rect":
      return `rect ${n(s.x)},${n(s.y)} ${n(s.w)}x${n(s.h)}`;
    case "polygon":
      return `poly ${s.points.map(xy).join(" ")}`;
    case "circle":
      return `circle ${n(s.cx)},${n(s.cy)} r${n(s.r)}`;
    case "ellipse":
      return `ellipse ${n(s.cx)},${n(s.cy)} r${n(s.rx)}x${n(s.ry)}`;
    case "blob":
      return `blob ${n(s.cx)},${n(s.cy)} r${n(s.r)}${s.roughness !== undefined ? ` rough=${n(s.roughness)}` : ""}${s.seed !== undefined ? ` seed=${s.seed}` : ""}`;
    case "cave":
      return `cave ${n(s.x)},${n(s.y)} ${n(s.w)}x${n(s.h)}${s.fill !== undefined ? ` fill=${n(s.fill)}` : ""}${s.steps !== undefined ? ` steps=${s.steps}` : ""}${s.seed !== undefined ? ` seed=${s.seed}` : ""}`;
    case "cells":
      return `cells ${n(s.x)},${n(s.y)} ${s.rows.reduce((a, r) => Math.max(a, r.length), 0)}x${s.rows.length} [${s.rows.join("/")}]`;
    case "path":
      return `path ${s.points.map(xy).join(">")}${s.width !== undefined ? ` w${s.width}` : ""}`;
    case "route": {
      const end = (e: string | Vec2): string => (typeof e === "string" ? e : xy(e));
      return `route ${end(s.from)}->${end(s.to)} w${s.width ?? 1} ${s.bend ?? "hv"} open=${s.openings ?? "open"}`;
    }
  }
}

export function formatOpeningEdge(o: Pick<ResolvedOpening, "orientation" | "start" | "width">): string {
  const [x, y] = o.start;
  return o.orientation === "h" ? `edge h ${x}..${x + o.width},${y}` : `edge v ${x},${y}..${y + o.width}`;
}

function areaLine(a: Area, lvl: ResolvedLevel | undefined, noteChars: number): string {
  const parts = [`AREA ${a.id} ${a.kind}`];
  if (a.key !== undefined) parts.push(`#${a.key}`);
  if (a.name !== undefined) parts.push(q(a.name));
  parts.push(formatShape(a.shape));
  if (a.walls !== undefined) parts.push(`walls=${a.walls}`);
  if (a.floor !== undefined) parts.push(`floor=${a.floor}`);
  if (a.floorHeight !== undefined) parts.push(`floorH=${n(a.floorHeight)}`);
  if (a.wallStyle !== undefined) parts.push(`wallStyle=${a.wallStyle}`);
  if (a.wallHeight !== undefined) parts.push(`wallH=${n(a.wallHeight)}`);
  if (a.theme !== undefined) parts.push(`theme=${a.theme}`);
  if (a.labelAt !== undefined) parts.push(`labelAt=${xy(a.labelAt)}`);
  if (a.tags && a.tags.length > 0) parts.push(`tags=${a.tags.join(",")}`);
  const ra = lvl?.areas.find((r) => r.id === a.id);
  if (ra) {
    const generated = a.shape.type === "route" || a.shape.type === "blob" || a.shape.type === "cave";
    if (ra.cellCount === 0) parts.push("-> EMPTY");
    else if (generated) {
      const b = ra.bbox;
      let extra = `-> ${ra.cellCount} cells x${b.x}-${b.x + b.w - 1} y${b.y}-${b.y + b.h - 1}`;
      if (a.shape.type === "route" && lvl) {
        const autos = lvl.openings.filter((o) => o.id === `${a.id}~a` || o.id === `${a.id}~b`);
        if (autos.length > 0) extra += `; ${autos.map((o) => `${o.id} ${formatOpeningEdge(o)}`).join(", ")}`;
      }
      parts.push(extra);
    }
  }
  const texts: string[] = [];
  if (a.notes) texts.push(`notes ${q(truncate(a.notes, noteChars))}`);
  if (a.readAloud) texts.push(`readAloud ${q(truncate(a.readAloud, noteChars))}`);
  if (a.encounter) texts.push(`encounter ${q(truncate(a.encounter, noteChars))}`);
  return `  ${parts.join(" ")}${texts.length > 0 ? ` | ${texts.join(" | ")}` : ""}`;
}

function featureToken(f: Feature, noteChars: number): string {
  const p = [`${f.id} ${f.type} ${xy(f.at)}`];
  if (f.rot) p.push(`r${f.rot}`);
  if (f.size) p.push(`${f.size[0]}x${f.size[1]}`);
  if (f.wall) p.push(`wall=${f.wall}`);
  if (f.lift !== undefined) p.push(`lift=${n(f.lift)}`);
  if (f.variant !== undefined) p.push(`variant=${f.variant}`);
  if (f.hint !== undefined) p.push(`hint=${q(f.hint)}`);
  if (f.label !== undefined) p.push(q(f.label));
  if (f.gmOnly) p.push("gm");
  if (f.notes) p.push(`notes ${q(truncate(f.notes, noteChars))}`);
  return p.join(" ");
}

function terrainLine(t: TerrainOp, lvl: ResolvedLevel | undefined): string {
  const p = [`TERR ${t.id} ${t.op}`];
  const layerOf = (t as { layer?: string }).layer;
  const layer = layerOf !== undefined ? ` layer=${layerOf}` : "";
  switch (t.op) {
    case "paint":
      p.push(`${t.material} ${formatShape(t.shape)}${layer}`);
      break;
    case "height":
      p.push(
        `${formatShape(t.shape)}${t.delta !== undefined ? ` delta=${n(t.delta)}` : ""}${t.set !== undefined ? ` set=${n(t.set)}` : ""}${t.smooth !== undefined ? ` smooth=${t.smooth}` : ""}${layer}`,
      );
      break;
    case "noise":
      p.push(
        `${t.material} ${formatShape(t.shape)} cov=${n(t.coverage)}${t.scale !== undefined ? ` scale=${n(t.scale)}` : ""}${t.seed !== undefined ? ` seed=${t.seed}` : ""}${layer}`,
      );
      break;
    case "path":
      p.push(
        `${t.material} ${t.points.map(xy).join(">")} w${n(t.width)}${t.jitter !== undefined ? ` jitter=${n(t.jitter)}` : ""}${t.seed !== undefined ? ` seed=${t.seed}` : ""}${layer}`,
      );
      break;
    case "scatter": {
      p.push(`${t.feature} ${t.shape ? formatShape(t.shape) : "whole-level"} d=${n(t.density)}`);
      if (t.minSpacing !== undefined) p.push(`spacing=${t.minSpacing}`);
      if (t.exclude && t.exclude.length > 0) p.push(`exclude=[${t.exclude.map(formatShape).join("; ")}]`);
      if (t.avoid) p.push(`avoid=${t.avoid.join(",")}`);
      if (t.variants) p.push(`variants=${t.variants.join(",")}`);
      if (t.randomRotation !== undefined) p.push(`randomRot=${String(t.randomRotation)}`);
      if (t.seed !== undefined) p.push(`seed=${t.seed}`);
      break;
    }
    case "dress":
      p.push(
        `${t.area} ${t.preset}${t.density !== undefined ? ` d=${n(t.density)}` : ""}${t.seed !== undefined ? ` seed=${t.seed}` : ""}`,
      );
      break;
  }
  if ((t.op === "scatter" || t.op === "dress") && lvl) {
    const count = lvl.features.filter((f) => f.generatedBy === t.id).length;
    p.push(`-> ${count} features`);
  }
  return `  ${p.join(" ")}`;
}

function levelLines(level: Level, lvl: ResolvedLevel | undefined, noteChars: number): string[] {
  const out: string[] = [];
  const base = level.base.type === "ground" ? `ground:${level.base.material}` : level.base.type;
  const b = level.bounds;
  out.push(
    `LEVEL ${level.id} ${q(level.name)} elev=${n(level.elevation)} bounds=${b.x},${b.y} ${b.w}x${b.h} base=${base}${level.theme ? ` theme=${level.theme}` : ""}${level.wallHeight !== undefined ? ` wallH=${n(level.wallHeight)}` : ""}`,
  );
  if (level.notes) out.push(`  notes ${q(truncate(level.notes, noteChars))}`);
  for (const a of level.areas) out.push(areaLine(a, lvl, noteChars));
  for (const o of level.openings) {
    const where = o.between
      ? `${o.between[0]}|${o.between[1]} @${n(o.position ?? 0.5)}`
      : o.at
        ? `at ${o.at.x},${o.at.y} ${o.at.side}`
        : "?";
    const ro = lvl?.openings.find((r) => r.id === o.id);
    const extra = [
      o.width !== undefined ? `w${o.width}` : "",
      o.gmOnly ? "gm" : "",
      o.label !== undefined ? q(o.label) : "",
    ].filter((s) => s !== "");
    out.push(
      `  OPEN ${o.id} ${o.kind} ${where}${extra.length > 0 ? ` ${extra.join(" ")}` : ""} -> ${ro ? formatOpeningEdge(ro) : "NOT PLACED"}`,
    );
  }
  for (const wr of level.walls) {
    out.push(
      `  WALL ${wr.id} ${wr.op} ${wr.points.map(xy).join(">")}${wr.style ? ` style=${wr.style}` : ""}${wr.height !== undefined ? ` h=${n(wr.height)}` : ""}`,
    );
  }
  const feats = level.features.map((f) => featureToken(f, noteChars));
  for (let i = 0; i < feats.length; i += 6) out.push(`  FEAT ${feats.slice(i, i + 6).join(" · ")}`);
  for (const t of level.terrain) out.push(terrainLine(t, lvl));
  for (const l of level.labels)
    out.push(`  LABEL ${l.id} ${q(l.text)} ${xy(l.at)}${l.size ? ` ${l.size}` : ""}`);
  if (level.stamps && level.stamps.length > 0)
    out.push(`  STAMPS ${level.stamps.map((s) => s.id).join(", ")} (unsupported in v1)`);
  return out;
}

export function outlineView(plan: MapPlan, resolved: ResolvedPlan | null, opts: OutlineOptions = {}): string {
  const noteChars = opts.noteChars ?? 60;
  const lines: string[] = [];
  const entry = entryLevelId(plan);
  lines.push(
    `PLAN${opts.version !== undefined ? ` v${opts.version}` : ""} ${q(plan.title)} ${plan.kind} theme=${plan.theme} seed=${plan.seed}${entry ? ` entry=${entry}` : ""}`,
  );
  if (plan.summary) lines.push(`  summary ${q(truncate(plan.summary, 120))}`);
  const keep = opts.levels ? new Set(opts.levels) : null;
  for (const level of plan.levels) {
    if (keep && !keep.has(level.id)) continue;
    lines.push(
      ...levelLines(
        level,
        resolved?.levels.find((l) => l.id === level.id),
        noteChars,
      ),
    );
  }
  for (const link of plan.links) {
    if (keep && !keep.has(link.from.level) && !keep.has(link.to.level)) continue;
    const rl = resolved?.links.find((l) => l.id === link.id);
    const dir = link.dir ?? "N";
    const res = rl
      ? `-> ${link.to.level} ${xy(rl.arrival)} (run ${rl.kind === "stairs" || rl.kind === "ramp" ? rl.lowerCells.length / (link.width ?? 1) : 1})`
      : `-> ${link.to.level} NOT RESOLVED`;
    lines.push(
      `LINK ${link.id} ${link.kind} ${link.from.level} ${xy(link.from.at)} dir=${dir}${link.width ? ` w${link.width}` : ""} ${res}${link.label ? ` ${q(link.label)}` : ""}`,
    );
  }
  const issues = opts.issues ?? resolved?.issues ?? [];
  if (issues.length === 0) lines.push("ISSUES none");
  else {
    lines.push(`ISSUES ${issues.length}`);
    for (const is of issues.slice(0, 30)) {
      lines.push(
        `  ${is.severity} ${is.code}${is.elementId ? ` ${is.elementId}` : ""}${is.cell ? ` @${is.cell[0]},${is.cell[1]}` : ""}: ${is.message}${is.hint ? ` (hint: ${is.hint})` : ""}`,
      );
    }
    if (issues.length > 30) lines.push(`  … ${issues.length - 30} more`);
  }
  return lines.join("\n");
}
