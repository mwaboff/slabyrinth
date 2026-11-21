/**
 * Realize, feature passes: every resolved feature (covered stalls through compile/stalls.ts, custom assets by name,
 * the run mix, cliff tones, wall-mounted and wall-facing pieces, assemblies), then the rock dressing piled on
 * outcrops.
 * Reads: the level's features, outcrops, edges and cells; the cliff tone helpers (cliffBand.ts); `runPicks`.
 * Writes: feature placements, `runPicks`; custom, vehicle, variant, footprint and landmark diagnostics.
 */
import type { CompileDiagnostic, Placement, RoleName } from "../../contracts/compiler";
import type { Side } from "../../contracts/plan";
import { EDGE, type ResolvedFeature } from "../../contracts/resolved";
import { stallPieceOf } from "../../gen/market";
import { featureRoles } from "../../gen/surfaces";
import { footprintFromGeom, type ResolvedVariant } from "../../palette/resolve";
import { h32, rotateDir, rotateXZ } from "../geometry";
import { realizeStall } from "../stalls";
import { cliffKinds, nearCliff, toneBoulders } from "./cliffBand";
import { EPS, opposite, type LevelWork } from "./work";

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

/** Loose rock that follows the tone of a cliff beside it (generator 3). */
const CLIFF_DRESSING = new Set(["formation", "rock_formation", "boulder", "rock"]);
/** Natural standing pieces that must never be built from wall blocks (generator 3). */
const NATURAL_STANDING = new Set(["cluster_tall", "formation", "landmark", "rock_formation", "tall_marker"]);

// ── 5. features ──
export function layFeatures(w: LevelWork): void {
  const { L, V, runPicks, emit } = w;
  const { seed, gen, frame, palettes, orientation, lookup, pick, facingOf, addDiag } = w.ctx;
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

  for (const f of L.features) placeFeature(f);

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
          ? lookup(
              L.id,
              theme,
              [...roles],
              { key: `variant:${wantFamily}`, test: (u) => u.variant === wantFamily },
              true,
            )
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
          if (tagged.some((u) => u.tone === tone))
            pool = pool.filter((u) => u.tone === undefined || u.tone === tone);
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
        const kind = /\b(bus|coach|van|truck|lorry|tram|cart|wagon|carriage|car|taxi|cab|jeep|pickup)\b/.exec(
          label,
        )?.[1];
        const CARS = new Set(["car", "taxi", "cab"]);
        const nameLc = (v.name ?? "").toLowerCase();
        const sameKind =
          kind === undefined || nameLc.includes(kind) || (CARS.has(kind) && /\b(car|taxi|cab)/.test(nameLc));
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
      const top = Math.max(v.geom.size.y, ...(v.parts ?? []).map((q) => (q.offset?.y ?? 0) + q.geom.size.y));
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
}

// outcrops are built up with the theme's rock formations: one on the crown, and formations and edge dressing
// piled round the foot, so a crag reads as a rock mass rather than a stack of blocks
export function dressOutcrops(w: LevelWork): void {
  const { L, V, topOf, emit } = w;
  const { seed, frame, lookup, pick } = w.ctx;
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
}
