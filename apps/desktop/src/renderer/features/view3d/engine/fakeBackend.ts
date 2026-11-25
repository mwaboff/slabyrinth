/**
 * A RenderBackend that records instead of drawing: the engine's tests (jsdom has no WebGL) and any host without a
 * GPU that still wants the engine's planning. It tracks the bytes it holds as a GPU would.
 */
import { meshGpuBytes, type FrameSample, type FrameUniforms, type RenderBackend } from "./backend";
import { DRAW_MESH, type DrawList } from "./plan";

export interface FakeBackend extends RenderBackend {
  readonly meshes: Map<number, number>;
  readonly buffers: Map<number, number>;
  draws: number;
  /** The last frame's draw calls by kind (mesh, box, summary) and instances drawn. */
  last: {
    calls: number;
    meshCalls: number;
    boxCalls: number;
    instances: number;
    uniforms: FrameUniforms | null;
  };
  /** Bytes held now (meshes and instance buffers). */
  heldBytes(): number;
  lose(): void;
  restore(): void;
}

export function fakeBackend(): FakeBackend {
  let lost = false;
  let width = 1;
  let height = 1;
  let next = 1;
  const meshes = new Map<number, number>();
  const buffers = new Map<number, number>();
  const b: FakeBackend = {
    label: "fake",
    meshes,
    buffers,
    draws: 0,
    last: { calls: 0, meshCalls: 0, boxCalls: 0, instances: 0, uniforms: null },
    isLost: () => lost,
    resize(w, h) {
      width = w;
      height = h;
    },
    createInstanceBuffer(_bytes, byteLength) {
      const h = next++;
      buffers.set(h, byteLength);
      return h;
    },
    deleteInstanceBuffer(h) {
      buffers.delete(h);
    },
    uploadMesh(mesh, geom) {
      const bytes = meshGpuBytes(geom);
      meshes.set(mesh, bytes);
      return bytes;
    },
    deleteMesh(mesh) {
      meshes.delete(mesh);
    },
    draw(u: FrameUniforms, list: DrawList) {
      b.draws++;
      let meshCalls = 0;
      let instances = 0;
      for (let i = 0; i < list.n; i++) {
        if (list.kind[i] === DRAW_MESH) meshCalls++;
        instances += list.count[i] ?? 0;
      }
      b.last = { calls: list.n, meshCalls, boxCalls: list.n - meshCalls, instances, uniforms: u };
    },
    framebufferBytes: () => width * height * 12,
    sample(): FrameSample {
      return { width, height, drawnPixels: b.last.instances > 0 ? 1 : 0, distinctIds: b.last.instances };
    },
    dispose() {
      meshes.clear();
      buffers.clear();
    },
    heldBytes() {
      let n = 0;
      for (const v of meshes.values()) n += v;
      for (const v of buffers.values()) n += v;
      return n;
    },
    lose() {
      lost = true;
      meshes.clear();
      buffers.clear();
    },
    restore() {
      lost = false;
    },
  };
  return b;
}
