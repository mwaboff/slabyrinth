/**
 * The fake main's 3D view and piece cache: the real scene of the open project's plan (core resolve and realize, the
 * bundled palettes), every piece a box of its real size as with no TaleSpire install, packed and capped exactly as
 * main packs it (shared/view3dWire.ts), and still pictures by the same shot rules (shared/view3dPictures.ts).
 */
import { bundledPalettes } from "@slabyrinth/core/palette";
import { boxMeshSource, type Scene } from "@slabyrinth/scene3d";
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

export function view3dHandlers(s: FakeState): HandlerGroup<View3dChannels> {
  const scenes = new Map<string, FakeScene>();
  let seq = 0;
  let cancelled = false;
  const wasCancelled = (): boolean => cancelled;
  const info = (): MeshCacheInfo => ({
    state: "no_install",
    read: 0,
    boxes: 0,
    extracting: false,
    bytes: 0,
    limitBytes: 512 * 1024 * 1024,
    message:
      "TaleSpire isn't installed on this PC (or Slabyrinth can't find it), so every piece shows as a box of its real size.",
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
      const { scene } = await sceneOfPlan(
        plan,
        bundledPalettes(),
        null,
        boxMeshSource("no-install", "boxes only"),
        undefined,
        (done, total) => {
          s.emit("view3d:progress", { sceneId, stage: "layout", done, total });
        },
      );
      if (wasCancelled()) return fail("cancelled", "Stopped.");
      const packed = packScene(scene);
      scenes.set(sceneId, { scene, packed });
      s.emit("meshes:status", { read: 0, boxes: packed.header.counts.boxes, extracting: false, bytes: 0 });
      return {
        ...packed.header,
        sceneId,
        version: v,
        buildId: buildId ?? null,
        pendingDetail: 0,
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
