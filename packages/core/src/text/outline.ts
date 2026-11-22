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
  Structure,
  TerrainOp,
  Vec2,
} from "../contracts/plan";
import type { ResolvedArea, ResolvedLevel, ResolvedOpening, ResolvedPlan } from "../contracts/resolved";
import { openingTests } from "../gen/openingKinds";
import { withWings } from "../plan/building";
import { generatorProfile, type GeneratorProfile } from "../plan/generator";
import { entryLevelId, isRunLink } from "../plan/links";
import { isRoomArea } from "../plan/validate";
import { isBareRoof } from "../resolve/roofTypes";

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

/**
 * How the resolver read a room (generator 4: gen/roomPurpose.ts classifyRoom, stored on the resolved area): its
 * purpose, stated by the plan or read from its words, and whether it is abandoned. Shown so the model can see a wrong
 * reading and state `purpose` (or rename the room) to correct it. Empty for an area that is no room and has no reading.
 */
function roomReading(a: Area, ra: ResolvedArea): string {
  const read =
    ra.purpose === undefined
      ? isRoomArea(a)
        ? "reads as no purpose"
        : ""
      : a.purpose === undefined
        ? `reads as ${ra.purpose}`
        : "";
  return [read, ra.abandoned === true ? "abandoned" : ""].filter((s) => s !== "").join(", ");
}

function areaLine(
  a: Area,
  lvl: ResolvedLevel | undefined,
  noteChars: number,
  profile: GeneratorProfile,
): string {
  const parts = [`AREA ${a.id} ${a.kind}`];
  if (a.key !== undefined) parts.push(`#${a.key}`);
  if (a.name !== undefined) parts.push(q(a.name));
  parts.push(formatShape(a.shape));
  if (a.walls !== undefined) parts.push(`walls=${a.walls}`);
  if (a.floor !== undefined) parts.push(`floor=${a.floor}`);
  if (a.floorHeight !== undefined) parts.push(`floorH=${n(a.floorHeight)}`);
  if (a.railing !== undefined) parts.push(`railing=${a.railing}`);
  if (a.crumble !== undefined) parts.push(`crumble=${n(a.crumble)}`);
  if (a.broken !== undefined) parts.push(`broken=${a.broken.map(xy).join(",")}`);
  if (a.wallStyle !== undefined) parts.push(`wallStyle=${a.wallStyle}`);
  if (a.wallHeight !== undefined) parts.push(`wallH=${n(a.wallHeight)}`);
  if (a.theme !== undefined) parts.push(`theme=${a.theme}`);
  if (a.labelAt !== undefined) parts.push(`labelAt=${xy(a.labelAt)}`);
  if (a.tags && a.tags.length > 0) parts.push(`tags=${a.tags.join(",")}`);
  if (profile.outlineRoomReading && a.purpose !== undefined) parts.push(`purpose=${a.purpose}`);
  const ra = lvl?.areas.find((r) => r.id === a.id);
  if (ra) {
    const generated = a.shape.type === "route" || a.shape.type === "blob" || a.shape.type === "cave";
    const facts: string[] = [];
    if (ra.cellCount === 0) facts.push("EMPTY");
    else if (generated) {
      const b = ra.bbox;
      let extra = `${ra.cellCount} cells x${b.x}-${b.x + b.w - 1} y${b.y}-${b.y + b.h - 1}`;
      if (a.shape.type === "route" && lvl) {
        const autos = lvl.openings.filter((o) => o.id === `${a.id}~a` || o.id === `${a.id}~b`);
        if (autos.length > 0) extra += `; ${autos.map((o) => `${o.id} ${formatOpeningEdge(o)}`).join(", ")}`;
      }
      facts.push(extra);
    }
    const reading = profile.outlineRoomReading ? roomReading(a, ra) : "";
    if (reading !== "") facts.push(reading);
    if (facts.length > 0) parts.push(`-> ${facts.join("; ")}`);
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
        `${t.material} ${t.points ? t.points.map(xy).join(">") : `connect=${(t.connect ?? []).map((c) => (typeof c === "string" ? c : xy(c))).join(">")}`}${t.kerb ? " kerb" : ""} w${n(t.width)}${t.jitter !== undefined ? ` jitter=${n(t.jitter)}` : ""}${t.seed !== undefined ? ` seed=${t.seed}` : ""}${layer}`,
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
        `${t.area ?? "(whole level)"} ${t.preset}${t.density !== undefined ? ` d=${n(t.density)}` : ""}${t.seed !== undefined ? ` seed=${t.seed}` : ""}`,
      );
      break;
    case "chasm": {
      p.push(
        `${t.points.map(xy).join(">")} w${n(t.width)} depth=${n(t.depth ?? 3)}${t.floor !== undefined ? ` floor=${t.floor}` : ""}${t.meander !== undefined ? ` meander=${n(t.meander)}` : ""}${t.seed !== undefined ? ` seed=${t.seed}` : ""}`,
      );
      (t.bridges ?? []).forEach((b, k) => {
        const rb = lvl?.bridges?.find((x) => x.id === `${t.id}~b${k + 1}`);
        p.push(
          `bridge ${t.id}~b${k + 1} at=${n(b.at ?? 0.5)} w${b.width ?? 2}${b.crumble ? ` crumble=${n(b.crumble)}` : ""}${rb ? ` -> ${rb.cells.length} cells, ${rb.broken.length} broken` : " -> not built"}`,
        );
      });
      break;
    }
  }
  if ((t.op === "scatter" || t.op === "dress") && lvl) {
    const count = lvl.features.filter((f) => f.generatedBy === t.id).length;
    p.push(`-> ${count} features`);
  }
  return `  ${p.join(" ")}`;
}

/** One line per building / enclosure: what was written, then what was built (resolved). */
function structureLine(
  st: Structure,
  lvl: ResolvedLevel | undefined,
  noteChars: number,
  profile: GeneratorProfile,
): string {
  const rs = lvl?.structures?.find((r) => r.id === st.id);
  if (st.kind === "enclosure") {
    const gates = (st.gates ?? [])
      .map((g) => `${g.side}${g.position !== undefined ? `@${n(g.position)}` : ""}`)
      .join(",");
    return `  STRUCT ${st.id} enclosure${st.key ? ` #${st.key}` : ""}${st.name ? ` ${q(st.name)}` : ""} ${formatShape(st.shape)} wall=${st.wall ?? "fence"}${gates ? ` gates=${gates}` : ""}${st.floor ? ` floor=${st.floor}` : ""}${rs ? ` -> ${rs.cells.length} cells` : " -> not built"}`;
  }
  const wings = (withWings(st).wings ?? [])
    .map((w) => `${w.x},${w.y} ${w.w}x${w.h}${w.ridge ? `/${w.ridge}` : ""}`)
    .join(" + ");
  const plan = [
    `  STRUCT ${st.id} building${st.key ? ` #${st.key}` : ""}${st.name ? ` ${q(st.name)}` : ""} style=${st.style ?? "cottage"}${st.seed !== undefined ? ` seed=${st.seed}` : ""}`,
    wings
      ? `wings ${wings}`
      : st.footprint
        ? formatShape(st.footprint)
        : (st.volumes ?? []).length > 0
          ? `volumes ${(st.volumes ?? []).map((v) => `${v.id} ${v.x},${v.y} ${v.w}x${v.h}${v.on ? ` on ${v.on}` : ""}`).join(" + ")}`
          : "",
    st.front ? `front=${st.front}` : "",
  ].filter(Boolean);
  if (!rs) return `${plan.join(" ")} -> not built`;
  const ops = (lvl?.openings ?? []).filter((o) => rs.openingIds.includes(o.id));
  // generator 4 (`openingKindTraits`): an arrow slit is counted with the windows (the kind table's trait); released
  // generators list it with the doors, as their outlines always did (gen/openingKinds.ts openingTests)
  const windowed = openingTests(profile).window;
  const doors = ops
    .filter((o) => !windowed(o.kind))
    .map((o) => `${o.id.split("~")[1] ?? o.id} ${formatOpeningEdge(o)}`);
  const windows =
    ops.filter((o) => windowed(o.kind)).length + rs.upperOpenings.filter((u) => windowed(u.kind)).length;
  const walls = rs.storeys
    .map((s) => `${s.footing ? `${s.footing.style}+` : ""}${s.walls ?? "open"}`)
    .join("/");
  const roof = rs.roof.type === rs.roof.requested ? rs.roof.type : `${rs.roof.requested}->${rs.roof.type}`;
  // phase 2: list the volumes when the massing is more than one plain block with one roof
  const vols = rs.volumes ?? [];
  const plainMass =
    vols.length <= 1 &&
    vols.every(
      (v) =>
        v.roof.layers.length <= 1 &&
        v.corners === "square" &&
        v.storeys.every((s, _i, all) => s.rect.w === all[0]?.rect.w && s.rect.h === all[0].rect.h),
    );
  const massing = plainMass
    ? []
    : vols.map((v) => {
        const widths = v.storeys
          .map((s) => (s.rect.w === s.rect.h ? `${s.rect.w}` : `${s.rect.w}x${s.rect.h}`))
          .join("/");
        const layers = v.roof.layers
          .map((l) => (l.type === l.requested ? l.type : `${l.requested}->${l.type}`))
          .join("+");
        return `volume ${v.id}${v.on ? ` on ${v.on}` : ""} ${v.storeys.length} storey${v.storeys.length > 1 ? "s" : ""} (${widths}${v.corners === "chamfer" ? " chamfered" : ""}) roof ${layers || "none"}`;
      });
  const built = [
    `${rs.storeys.length} storey${rs.storeys.length > 1 ? "s" : ""} (${walls})`,
    `roof ${roof}${!isBareRoof(rs.roof.type) ? ` ${rs.roof.style}` : ""}`,
    ...massing,
    rs.plinth ? `plinth ${n(rs.plinth.height)}` : "",
    ...doors,
    `${windows} window${windows === 1 ? "" : "s"}`,
    rs.chimneys.length ? `chimney ${rs.chimneys.map((c) => `${c.side} ${xy(c.at)}`).join(",")}` : "",
    rs.porches.length ? `porch ${rs.porches.map((p) => `${p.side} ${p.cells.length} cells`).join(",")}` : "",
  ].filter(Boolean);
  const notes = st.notes ? ` | notes ${q(truncate(st.notes, noteChars))}` : "";
  return `${plan.join(" ")} -> ${built.join(", ")}${notes}`;
}

function levelLines(
  level: Level,
  lvl: ResolvedLevel | undefined,
  noteChars: number,
  profile: GeneratorProfile,
): string[] {
  const out: string[] = [];
  const base = level.base.type === "ground" ? `ground:${level.base.material}` : level.base.type;
  const b = level.bounds;
  out.push(
    `LEVEL ${level.id} ${q(level.name)} elev=${n(level.elevation)} bounds=${b.x},${b.y} ${b.w}x${b.h} base=${base}${level.theme ? ` theme=${level.theme}` : ""}${level.wallHeight !== undefined ? ` wallH=${n(level.wallHeight)}` : ""}`,
  );
  if (level.notes) out.push(`  notes ${q(truncate(level.notes, noteChars))}`);
  for (const a of level.areas) out.push(areaLine(a, lvl, noteChars, profile));
  for (const st of level.structures ?? []) out.push(structureLine(st, lvl, noteChars, profile));
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
  const profile = generatorProfile(plan);
  for (const level of plan.levels) {
    if (keep && !keep.has(level.id)) continue;
    lines.push(
      ...levelLines(
        level,
        resolved?.levels.find((l) => l.id === level.id),
        noteChars,
        profile,
      ),
    );
  }
  for (const link of plan.links) {
    if (keep && !keep.has(link.from.level) && !keep.has(link.to.level)) continue;
    const rl = resolved?.links.find((l) => l.id === link.id);
    const dir = link.dir ?? "N";
    const res = rl
      ? `-> ${link.to.level} ${xy(rl.arrival)} (run ${isRunLink(rl.kind) ? rl.lowerCells.length / (link.width ?? 1) : 1})`
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
