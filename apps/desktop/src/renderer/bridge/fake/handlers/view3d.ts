/**
 * The fake main's 3D view and piece cache: the real scene of the open project's plan (core resolve and realize, the
 * bundled palettes), every piece a box of its real size (why: the scenario's `meshes` state, default no TaleSpire
 * install; "reading" sends each version's first scene as boxes waiting for detail, then "detail" progress), packed and capped exactly as
 * main packs it (shared/view3dWire.ts), and still pictures by the same shot rules (shared/view3dPictures.ts).
 */
import { bundledPalettes } from "@slabyrinth/core/palette";
import { boxMeshSource, type FallbackReason, type Scene } from "@slabyrinth/scene3d";
import type { MeshCacheInfo } from "../../../../shared/ipc";
import { VIEW3D_LIMITS } from "../../../../shared/schemas/ipc";
import { onePicture } from "../../../../shared/view3dPictures";
import { sceneOfPlan } from "../../../../shared/view3dScene";
import { packScene, takeWithin, type PackedScene } from "../../../../shared/view3dWire";
import { fail, type FakeState, type HandlerGroup } from "../state";

type View3dChannels =
  | "view3d:open"
  | "view3d:chunks"
  | "view3d:meshes"
  | "view3d:shot"
  | "view3d:cancel"
  | "view3d:close"
  | "meshes:info"
  | "meshes:rebuild"
  | "meshes:clear";

interface FakeScene {
  scene: Scene;
  packed: PackedScene;
}

/** How long the "reading" scenario takes to read a version's shapes (scaled by the bridge's speed). */
const READ_MS = 400;

const MESSAGES: Readonly<Record<MeshCacheInfo["state"], string>> = {
  no_install:
    "TaleSpire isn't installed on this PC (or Slabyrinth can't find it), so every piece shows as a box of its real size.",
  reading: "Reading TaleSpire's pieces (once after each game update). Boxes in the meantime.",
  off: "3D is turned off, so every piece shows as a box of its real size.",
  ready: "TaleSpire's pieces are read.",
};

/** Why a piece is a box in each state (the "reading" scenario: before and after its version's shapes are read). */
function boxReason(state: MeshCacheInfo["state"], read: boolean): FallbackReason {
  if (state === "off") return "boxes-requested";
  if (state === "reading") return read ? "not-in-index" : "not-read-yet";
  return "no-install";
}

export function view3dHandlers(s: FakeState): HandlerGroup<View3dChannels> {
  const scenes = new Map<string, FakeScene>();
  let seq = 0;
  let cancelled = false;
  const wasCancelled = (): boolean => cancelled;
  const state = s.scenario.meshes ?? "no_install";
  /** Versions whose shapes the "reading" scenario has read. */
  const read = new Set<number>();
  const info = (): MeshCacheInfo => ({
    state: state === "reading" && read.size > 0 ? "ready" : state,
    read: 0,
    boxes: 0,
    extracting: state === "reading" && read.size === 0,
    bytes: 0,
    limitBytes: 512 * 1024 * 1024,
    message: MESSAGES[state === "reading" && read.size > 0 ? "ready" : state],
  });
  const sceneOf = (sceneId: string): FakeScene =>
    scenes.get(sceneId) ?? fail("not_found", "That 3D view was closed.");
  return {
    "view3d:open": async ({ version, buildId }) => {
      const p = s.open();
      let v = version ?? p.history.head;
      if (buildId !== undefined) {
        const b = p.builds.find((x) => x.id === buildId);
        if (!b) return fail("not_found", "That build isn't in this map.");
        v = b.versionNumber;
      }
      const plan = s.planAt(p, v);
      if (!plan)
        return v === 0
          ? fail("validation", "There's no plan to show yet.")
          : fail("not_found", `No version v${String(v)}.`);
      cancelled = false;
      // one scene at a time, as main keeps it
      scenes.clear();
      const sceneId = `fake-scene-${String(++seq)}`;
      const wasRead = read.has(v);
      const { scene } = await sceneOfPlan(
        plan,
        bundledPalettes(),
        null,
        boxMeshSource(boxReason(state, wasRead), "boxes only"),
        undefined,
        (done, total) => {
          s.emit("view3d:progress", { sceneId, stage: "layout", done, total });
        },
      );
      if (wasCancelled()) return fail("cancelled", "Stopped.");
      const packed = packScene(scene);
      scenes.set(sceneId, { scene, packed });
      const pending = state === "reading" && !wasRead ? packed.header.counts.instances : 0;
      s.emit("meshes:status", {
        read: 0,
        boxes: packed.header.counts.boxes,
        extracting: pending > 0,
        bytes: 0,
      });
      if (pending > 0)
        void s.sleep(READ_MS).then(() => {
          read.add(v);
          s.emit("view3d:progress", { sceneId, stage: "detail", done: pending, total: pending });
        });
      return {
        ...packed.header,
        sceneId,
        version: v,
        buildId: buildId ?? null,
        pendingDetail: pending,
        limited: null,
      };
    },
    "view3d:chunks": ({ sceneId, chunkIds }) => {
      const { packed } = sceneOf(sceneId);
      const r = takeWithin(chunkIds, (id) => packed.chunks.get(id), VIEW3D_LIMITS.replyBytes);
      return { chunks: r.items, more: r.more };
    },
    "view3d:meshes": ({ sceneId, keys }) => {
      const { packed } = sceneOf(sceneId);
      const r = takeWithin(keys, (k) => packed.meshes.get(k), VIEW3D_LIMITS.replyBytes);
      return { meshes: r.items, more: r.more };
    },
    "view3d:shot": ({ sceneId, shot, width, height }) => {
      const { scene } = sceneOf(sceneId);
      return onePicture(scene, shot, width, height) ?? fail("not_found", `Nothing to show for ${shot}.`);
    },
    "view3d:cancel": () => {
      cancelled = true;
    },
    "view3d:close": ({ sceneId }) => {
      scenes.delete(sceneId);
    },
    "meshes:info": () => info(),
    "meshes:rebuild": () => info(),
    "meshes:clear": () => info(),
  };
}
