/**
 * The thin layer between the engine and the GPU. The engine plans frames and manages residency without touching GL;
 * a backend uploads buffers and executes a DrawList. `gl/glBackend.ts` is the WebGL2 one; tests use a recording fake.
 */
import type { MeshGeometry } from "../sceneSource";
import type { FilterMasks } from "./filters";
import type { DrawList } from "./plan";

export interface FrameUniforms {
  /** Column-major view-projection. */
  viewProj: Float32Array;
  eye: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  /** Pixels one world unit covers at distance 1. */
  pxK: number;
  /** Pieces smaller than this on screen (pixels) are skipped. */
  minPx: number;
  masks: FilterMasks;
  fade: boolean;
  fadeRadius: number;
  /** The selected instance id, or NO_SELECTION. */
  selected: number;
  /** 0..1 rgb. */
  background: readonly [number, number, number];
  /** The ground grid: its height and extent (no grid when `show` is false). */
  grid: { show: boolean; y: number; minX: number; maxX: number; minZ: number; maxZ: number };
}

export const NO_SELECTION = 0xffffffff;

/** What a readback of the last frame found (tests and the e2e harness). */
export interface FrameSample {
  width: number;
  height: number;
  /** Pixels showing a piece (non-zero id). */
  drawnPixels: number;
  /** Distinct piece ids seen (capped at 4,096). */
  distinctIds: number;
}

export interface RenderBackend {
  readonly label: string;
  isLost(): boolean;
  /** Drawing-buffer size in device pixels. */
  resize(width: number, height: number): void;
  /** A GPU buffer holding the first `byteLength` bytes of `bytes`; returns a handle. */
  createInstanceBuffer(bytes: Uint8Array, byteLength: number): number;
  deleteInstanceBuffer(handle: number): void;
  /** Uploads a mesh under its mesh-table index; returns the GPU bytes it took. */
  uploadMesh(mesh: number, geom: MeshGeometry): number;
  deleteMesh(mesh: number): void;
  draw(u: FrameUniforms, list: DrawList): void;
  /** Bytes of the offscreen targets (colour, id, depth). */
  framebufferBytes(): number;
  sample(): FrameSample;
  dispose(): void;
}

/** GPU bytes a mesh takes: positions as given, indices 16-bit when every vertex index fits. */
export function meshGpuBytes(geom: MeshGeometry): number {
  const vertices = Math.floor(geom.positions.length / 3);
  return geom.positions.byteLength + geom.indices.length * (vertices <= 65_536 ? 2 : 4);
}
