import {
  LevelGrid,
  type MapPlan,
  type OrientationCalibration,
  type PaletteCatalog,
  type ReadonlyFs,
  type ResolvedPlan,
} from "@slabyrinth/core";
import { diffPlans } from "@slabyrinth/core/ops";
import { buildPaletteCatalog, loadOrientation } from "@slabyrinth/core/palette";
import { reviewDesign } from "@slabyrinth/core/review";
import {
  boxMeshSource,
  budgetedSource,
  installMeshSource,
  planFacts,
  runChecks,
  type Finding,
  type InstallMeshSource,
  type MeshSource,
  type Scene,
  type ShotContext,
} from "@slabyrinth/scene3d";
import { indexElements } from "@slabyrinth/core/plan";
import { onePicture, scenePictures, type PlannedKind } from "../../shared/view3dPictures";
import { sceneOfPlan } from "../../shared/view3dScene";
import { packScene, takeWithin, type PackedScene } from "../../shared/view3dWire";
import { DiskMeshCache } from "../services/meshes/diskCache";
import { nodeReadonlyFs } from "../services/talespire/steamLocator";
import type { SceneJob, SceneWorkerRequest, SceneWorkerResponse } from "./sceneProtocol";

/**
 * Worker-side scene keeper (scene.worker wires it to parentPort; tests call it in-process). Lays out a plan's scene
 * from the piece cache only (never reading the game cold: pieces not read yet are boxes), holds it by id, and serves
 * its chunks, meshes and pictures. Scenes stay until released; main keeps one per window and one for the model.
 */
export const LIMITED_WORDS = "Detail limited to keep Slabyrinth responsive: some pieces show as boxes.";

interface Held {
  scene: Scene;
  packed: PackedScene;
  plan: MapPlan;
  previous: MapPlan | null;
  resolved: ResolvedPlan;
  palettes: PaletteCatalog;
  orientation: OrientationCalibration;
  ctx: ShotContext | null;
  /** The scene checks' findings, measured when a picture for the model first needs them (null: they failed). */
  findings?: Finding[] | null;
}

/** What each plan element id of a held scene is (a generated piece's id is not the plan's: null). */
function kindsOf(h: Held): PlannedKind {
  const index = indexElements(h.plan);
  return (id) => index.get(id)?.kind ?? null;
}

/** The scene checks over a held scene, once (a check that throws costs the picture its findings, never the picture). */
function findingsOf(h: Held): Finding[] | null {
  if (h.findings !== undefined) return h.findings;
  try {
    h.findings = runChecks(h.scene, planFacts(h.resolved, h.scene, { orientation: h.orientation })).findings;
  } catch {
    h.findings = null;
  }
  return h.findings;
}

/** Each area's plan cells, by area id (the level grid's own cell owner). */
function footprintsOf(resolved: ResolvedPlan): Map<string, Array<readonly [string, number, number]>> {
  const out = new Map<string, Array<readonly [string, number, number]>>();
  for (const level of resolved.levels) {
    const grid = new LevelGrid(level);
    for (let y = grid.y0; y < grid.y0 + grid.h; y++)
      for (let x = grid.x0; x < grid.x0 + grid.w; x++) {
        const a = grid.cell(x, y).area;
        const id = a > 0 ? level.areaIds[a - 1] : undefined;
        if (id === undefined) continue;
        let list = out.get(id);
        if (!list) out.set(id, (list = []));
        list.push([level.id, x, y]);
      }
  }
  return out;
}

/** The review notes and the last change, worked out once per scene when a picture first needs them. */
function contextOf(h: Held): ShotContext {
  if (h.ctx) return h.ctx;
  const notes = reviewDesign(h.plan, h.resolved, h.palettes).map((n) => ({
    levelId: n.levelId,
    ...(n.cell ? { cell: [n.cell[0], n.cell[1]] as const } : {}),
    ...(n.elementIds ? { elementIds: n.elementIds } : {}),
    label: n.code.replace(/_/g, " "),
    score: n.score,
  }));
  const ctx: ShotContext = { notes, footprints: footprintsOf(h.resolved) };
  if (h.previous) {
    const d = diffPlans(h.previous, h.plan);
    ctx.changed = {
      ids: [
        ...new Set([...d.added.map((x) => x.id), ...d.changed.map((x) => x.id), ...d.areas.changed]),
      ].sort(),
      removed: d.removed.length,
    };
  }
  h.ctx = ctx;
  return ctx;
}

export function createSceneHandler(o: { fs?: ReadonlyFs } = {}) {
  const held = new Map<string, Held>();
  const installs = new Map<string, InstallMeshSource>();
  const fs = o.fs ?? nodeReadonlyFs;

  const sourceFor = (job: SceneJob): { source: MeshSource; cut: () => number } => {
    const m = job.meshes;
    if (m.mode === "boxes")
      return {
        source: boxMeshSource(
          m.reason,
          m.reason === "no-install" ? "boxes: TaleSpire not found" : "boxes: 3D off",
        ),
        cut: () => 0,
      };
    const key = `${m.installPath}\n${m.cacheDir}`;
    let install = installs.get(key);
    if (!install) {
      install = installMeshSource({
        fs,
        installPath: m.installPath,
        cache: new DiskMeshCache(m.cacheDir, m.limitBytes, false),
        coldRead: false,
      });
      installs.set(key, install);
    }
    const b = budgetedSource(install, job.meshBudgetBytes);
    return { source: b, cut: () => b.last.cut };
  };

  const get = (sceneId: string): Held | undefined => held.get(sceneId);

  return async (msg: SceneWorkerRequest, post: (r: SceneWorkerResponse) => void): Promise<void> => {
    const notFound = (): void => {
      post({ type: "error", id: msg.id, message: "That 3D view was closed.", code: "not_found" });
    };
    try {
      switch (msg.type) {
        case "build": {
          const t0 = performance.now();
          const job = msg.job;
          const palettes = buildPaletteCatalog(job.userPalettes, job.catalog ? job.catalog.assets : null);
          const orientation = loadOrientation(job.orientationOverride ?? undefined).orientation;
          const { source, cut } = sourceFor(job);
          const { scene, resolved } = await sceneOfPlan(
            job.plan,
            palettes,
            job.catalog,
            source,
            orientation,
            (done, total) => {
              post({ type: "progress", id: msg.id, done, total });
            },
          );
          const packed = packScene(scene);
          held.set(job.sceneId, {
            scene,
            packed,
            plan: job.plan,
            previous: job.previous,
            resolved,
            palettes,
            orientation,
            ctx: null,
          });
          post({
            type: "built",
            id: msg.id,
            scene: {
              header: packed.header,
              pending: scene.fallbacks.filter((f) => f.reason === "not-read-yet").map((f) => f.uuid),
              uuids: [...new Set(scene.instances.map((i) => i.uuid))].sort(),
              limited: cut() > 0 ? LIMITED_WORDS : null,
              ms: Math.round(performance.now() - t0),
            },
          });
          return;
        }
        case "chunks": {
          const h = get(msg.sceneId);
          if (!h) {
            notFound();
            return;
          }
          const r = takeWithin(msg.ids, (id) => h.packed.chunks.get(id), msg.capBytes);
          post({ type: "chunks", id: msg.id, chunks: r.items, more: r.more });
          return;
        }
        case "meshes": {
          const h = get(msg.sceneId);
          if (!h) {
            notFound();
            return;
          }
          const r = takeWithin(msg.keys, (k) => h.packed.meshes.get(k), msg.capBytes);
          post({ type: "meshes", id: msg.id, meshes: r.items, more: r.more });
          return;
        }
        case "pictures": {
          const h = get(msg.sceneId);
          if (!h) {
            notFound();
            return;
          }
          const req = {
            ...(msg.shots ? { shots: msg.shots } : {}),
            ...(msg.max !== undefined ? { max: msg.max } : {}),
          };
          // the model's pictures carry the measured findings for the pieces in view
          const p = scenePictures(h.scene, req, contextOf(h), findingsOf(h), kindsOf(h));
          post({ type: "pictures", id: msg.id, ...p });
          return;
        }
        case "shot": {
          const h = get(msg.sceneId);
          if (!h) {
            notFound();
            return;
          }
          const p = onePicture(h.scene, msg.shot, msg.width, msg.height, contextOf(h));
          if (!p) {
            post({
              type: "error",
              id: msg.id,
              message: `Nothing to show for ${msg.shot}.`,
              code: "not_found",
            });
            return;
          }
          post({ type: "shot", id: msg.id, ...p });
          return;
        }
        case "release":
          held.delete(msg.sceneId);
          post({ type: "released", id: msg.id });
          return;
      }
    } catch (err) {
      post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  };
}
