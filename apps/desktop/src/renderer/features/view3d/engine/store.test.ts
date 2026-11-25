/**
 * The viewer's scene store refuses a chunk that disagrees with the header or with itself, and the per-piece flag word
 * has room for every colour class and placement role.
 */
import { ROLE_ORDER } from "@slabyrinth/core/compile";
import { beforeAll, describe, expect, it } from "vitest";
import { CLASS_ORDER } from "../../../../shared/view3dWire";
import { packScene, type PackedScene } from "../memorySceneSource";
import type { InstanceChunk } from "../sceneSource";
import { syntheticTown } from "../synthetic";
import { ChunkState, SceneStore } from "./store";

let packed: PackedScene;
let first: InstanceChunk;
beforeAll(async () => {
  packed = packScene(await syntheticTown({ side: 64 }), "s1", "b1");
  const c = [...packed.chunks.values()].find((x) => x.count > 2);
  if (!c) throw new Error("the synthetic town has a chunk of pieces");
  first = c;
});

describe("scene store", () => {
  it("loads a chunk that agrees with the header", () => {
    const store = new SceneStore(packed.header);
    expect(store.load(first)?.state).toBe(ChunkState.Loaded);
    expect(store.loadedInstances).toBe(first.count);
  });

  it("refuses a chunk whose count is not the header's (picks would name the wrong pieces)", () => {
    const store = new SceneStore(packed.header);
    const lying = { ...first, count: first.count - 1 };
    expect(store.load(lying)).toBeUndefined();
    expect(store.chunkById(first.id)?.state).toBe(ChunkState.Failed);
    expect(store.loadedInstances).toBe(0);
    expect(store.chunkOf(store.chunkById(first.id)?.base ?? 0)?.data).toBeNull();
  });

  it("refuses a chunk whose arrays are shorter than its count, or whose indices are past the tables", () => {
    const store = new SceneStore(packed.header);
    expect(store.load({ ...first, transform: first.transform.subarray(4) })).toBeUndefined();
    const mesh = Uint32Array.from(first.mesh);
    mesh[1] = packed.header.meshes.length;
    expect(store.load({ ...first, mesh })).toBeUndefined();
    const name = Uint32Array.from(first.name);
    name[0] = first.names.length;
    expect(store.load({ ...first, name })).toBeUndefined();
    expect(store.loadedInstances).toBe(0);
  });
});

describe("the per-piece flag word (filters.pieceFlags)", () => {
  it("has room for every colour class (4 bits) and every placement role (4 bits, 0 = none)", () => {
    expect(CLASS_ORDER.length).toBeLessThanOrEqual(16);
    expect(packed.header.classes.length).toBe(CLASS_ORDER.length);
    expect(ROLE_ORDER.length).toBeLessThan(16);
  });
});
