/**
 * The WebGL2 backend: instanced pieces into an offscreen colour + id + depth target, then one composite pass to the
 * canvas that draws the outlines. One vertex array per resident mesh (its positions and indices, plus the instance
 * attributes, re-pointed per draw at the chunk buffer's range: WebGL2 has no base instance), one for the unit cube.
 * Handles context loss: every GL object is forgotten and rebuilt on restore; the engine re-requests what it needs.
 */
import { cuboid } from "@slabyrinth/scene3d";
import type { MeshGeometry } from "../sceneSource";
import { meshGpuBytes, type FrameSample, type FrameUniforms, type RenderBackend } from "../engine/backend";
import { DRAW_MESH, type DrawList } from "../engine/plan";
import { INSTANCE_STRIDE, OFF_COLOUR, OFF_FLAGS, OFF_ID, OFF_MAX, OFF_MIN, OFF_PLACE } from "../engine/pack";
import { COMPOSITE_FS, COMPOSITE_VS, GRID_FS, GRID_VS, PIECE_FS, PIECE_VS } from "./shaders";

/** The software renderer's light (scene3d raster.ts), normalised. */
const LIGHT = (() => {
  const l = [-0.45, 0.8, -0.35];
  const n = Math.hypot(l[0] ?? 0, l[1] ?? 0, l[2] ?? 0);
  return new Float32Array(l.map((v) => v / n));
})();

/** Why the viewer cannot draw: no WebGL2, or the GPU refused the programs. */
export class GlUnavailable extends Error {
  readonly reason: "no-webgl2" | "init-failed";
  constructor(reason: "no-webgl2" | "init-failed", message: string) {
    super(message);
    this.name = "GlUnavailable";
    this.reason = reason;
  }
}

interface MeshRec {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  indexCount: number;
  indexType: number;
}

interface Programs {
  piece: WebGLProgram;
  grid: WebGLProgram;
  composite: WebGLProgram;
  u: {
    viewProj: WebGLUniformLocation | null;
    eye: WebGLUniformLocation | null;
    pxK: WebGLUniformLocation | null;
    minPx: WebGLUniformLocation | null;
    box: WebGLUniformLocation | null;
    hideClass: WebGLUniformLocation | null;
    hideRole: WebGLUniformLocation | null;
    hideRoof: WebGLUniformLocation | null;
    light: WebGLUniformLocation | null;
    target: WebGLUniformLocation | null;
    fade: WebGLUniformLocation | null;
    fadeRadius: WebGLUniformLocation | null;
    cutHeight: WebGLUniformLocation | null;
    selected: WebGLUniformLocation | null;
    gViewProj: WebGLUniformLocation | null;
    gExtent: WebGLUniformLocation | null;
    gY: WebGLUniformLocation | null;
    gBg: WebGLUniformLocation | null;
    cColour: WebGLUniformLocation | null;
    cId: WebGLUniformLocation | null;
  };
}

interface Target {
  fbo: WebGLFramebuffer;
  colour: WebGLTexture;
  id: WebGLTexture;
  depth: WebGLRenderbuffer;
  width: number;
  height: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new GlUnavailable("init-failed", "Could not create a shader.");
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost())
    throw new GlUnavailable("init-failed", `Shader did not compile: ${gl.getShaderInfoLog(s) ?? ""}`);
  return s;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
    throw new GlUnavailable("init-failed", `Program did not link: ${gl.getProgramInfoLog(p) ?? ""}`);
  gl.deleteShader(v);
  gl.deleteShader(f);
  return p;
}

export interface GlBackendHandlers {
  onLost(): void;
  onRestored(): void;
}

/** Creates the WebGL2 backend on a canvas; throws GlUnavailable when the context or programs cannot be had. */
export function createGlBackend(canvas: HTMLCanvasElement, handlers: GlBackendHandlers): RenderBackend {
  const ctx = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (!ctx) throw new GlUnavailable("no-webgl2", "WebGL2 is not available.");
  const gl: WebGL2RenderingContext = ctx;
  let lost = false;
  let programs: Programs;
  let cube: { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; ibo: WebGLBuffer };
  let emptyVao: WebGLVertexArrayObject;
  let target: Target | null = null;
  let width = 1;
  let height = 1;
  const meshes = new Map<number, MeshRec>();
  const buffers = new Map<number, WebGLBuffer>();
  let nextHandle = 1;

  function setupInstanceAttribs(): void {
    for (let loc = 1; loc <= 6; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribDivisor(loc, 1);
    }
  }

  function init(): void {
    const piece = link(gl, PIECE_VS, PIECE_FS);
    const grid = link(gl, GRID_VS, GRID_FS);
    const composite = link(gl, COMPOSITE_VS, COMPOSITE_FS);
    const at = (p: WebGLProgram, n: string): WebGLUniformLocation | null => gl.getUniformLocation(p, n);
    programs = {
      piece,
      grid,
      composite,
      u: {
        viewProj: at(piece, "uViewProj"),
        eye: at(piece, "uEye"),
        pxK: at(piece, "uPxK"),
        minPx: at(piece, "uMinPx"),
        box: at(piece, "uBox"),
        hideClass: at(piece, "uHideClass"),
        hideRole: at(piece, "uHideRole"),
        hideRoof: at(piece, "uHideRoof"),
        light: at(piece, "uLight"),
        target: at(piece, "uTarget"),
        fade: at(piece, "uFade"),
        fadeRadius: at(piece, "uFadeRadius"),
        cutHeight: at(piece, "uCutHeight"),
        selected: at(piece, "uSelected"),
        gViewProj: at(grid, "uViewProj"),
        gExtent: at(grid, "uExtent"),
        gY: at(grid, "uY"),
        gBg: at(grid, "uBg"),
        cColour: at(composite, "uColour"),
        cId: at(composite, "uId"),
      },
    };
    // the unit cube: scene3d's cuboid over 0..1
    const c = cuboid({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, c.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(c.indices), gl.STATIC_DRAW);
    setupInstanceAttribs();
    gl.bindVertexArray(null);
    cube = { vao, vbo, ibo };
    emptyVao = gl.createVertexArray();
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    target = null;
    makeTarget();
  }

  function makeTarget(): void {
    if (target) {
      gl.deleteFramebuffer(target.fbo);
      gl.deleteTexture(target.colour);
      gl.deleteTexture(target.id);
      gl.deleteRenderbuffer(target.depth);
      target = null;
    }
    const tex = (internal: number, format: number, type: number): WebGLTexture => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const colour = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const id = tex(gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, id, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    target = { fbo, colour, id, depth, width, height };
  }

  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  function onLost(e: Event): void {
    e.preventDefault();
    lost = true;
    meshes.clear();
    buffers.clear();
    target = null;
    handlers.onLost();
  }
  function onRestored(): void {
    lost = false;
    try {
      init();
    } catch {
      lost = true;
      return;
    }
    handlers.onRestored();
  }

  init();

  function bindInstances(buf: WebGLBuffer, first: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const base = first * INSTANCE_STRIDE;
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, INSTANCE_STRIDE, base + OFF_PLACE);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, INSTANCE_STRIDE, base + OFF_MIN);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, INSTANCE_STRIDE, base + OFF_MAX);
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, INSTANCE_STRIDE, base + OFF_COLOUR);
    gl.vertexAttribIPointer(5, 1, gl.UNSIGNED_INT, INSTANCE_STRIDE, base + OFF_FLAGS);
    gl.vertexAttribIPointer(6, 1, gl.UNSIGNED_INT, INSTANCE_STRIDE, base + OFF_ID);
  }

  const clearColour = new Float32Array(4);
  const clearId = new Uint32Array(4);
  const clearDepth = new Float32Array([1]);
  const drawBuffers = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1];

  return {
    label: "webgl2",
    isLost: () => lost || gl.isContextLost(),
    resize(w: number, h: number): void {
      const nw = Math.max(1, Math.floor(w));
      const nh = Math.max(1, Math.floor(h));
      if (nw === width && nh === height && target) return;
      width = nw;
      height = nh;
      canvas.width = nw;
      canvas.height = nh;
      if (!lost) makeTarget();
    },
    createInstanceBuffer(bytes: Uint8Array, byteLength: number): number {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW, 0, byteLength);
      const h = nextHandle++;
      buffers.set(h, b);
      return h;
    },
    deleteInstanceBuffer(h: number): void {
      const b = buffers.get(h);
      if (b) gl.deleteBuffer(b);
      buffers.delete(h);
    },
    uploadMesh(mesh: number, geom: MeshGeometry): number {
      const vertices = Math.floor(geom.positions.length / 3);
      const small = vertices <= 65_536;
      const indices =
        small && !(geom.indices instanceof Uint16Array) ? Uint16Array.from(geom.indices) : geom.indices;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, geom.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      setupInstanceAttribs();
      gl.bindVertexArray(null);
      meshes.set(mesh, {
        vao,
        vbo,
        ibo,
        indexCount: indices.length,
        indexType: indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
      });
      return meshGpuBytes(geom);
    },
    deleteMesh(mesh: number): void {
      const r = meshes.get(mesh);
      if (!r) return;
      gl.deleteVertexArray(r.vao);
      gl.deleteBuffer(r.vbo);
      gl.deleteBuffer(r.ibo);
      meshes.delete(mesh);
    },
    draw(u: FrameUniforms, list: DrawList): void {
      if (lost || !target) return;
      const P = programs;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.drawBuffers(drawBuffers);
      gl.viewport(0, 0, width, height);
      clearColour[0] = u.background[0];
      clearColour[1] = u.background[1];
      clearColour[2] = u.background[2];
      clearColour[3] = 1;
      gl.clearBufferfv(gl.COLOR, 0, clearColour);
      gl.clearBufferuiv(gl.COLOR, 1, clearId);
      gl.clearBufferfv(gl.DEPTH, 0, clearDepth);
      // ground grid, as background
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      if (u.grid.show) {
        gl.useProgram(P.grid);
        gl.uniformMatrix4fv(P.u.gViewProj, false, u.viewProj);
        gl.uniform4f(P.u.gExtent, u.grid.minX, u.grid.maxX, u.grid.minZ, u.grid.maxZ);
        gl.uniform1f(P.u.gY, u.grid.y);
        gl.uniform3f(P.u.gBg, u.background[0], u.background[1], u.background[2]);
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      // pieces
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.useProgram(P.piece);
      gl.uniformMatrix4fv(P.u.viewProj, false, u.viewProj);
      gl.uniform3f(P.u.eye, u.eye.x, u.eye.y, u.eye.z);
      gl.uniform1f(P.u.pxK, u.pxK);
      gl.uniform1f(P.u.minPx, u.minPx);
      gl.uniform1ui(P.u.hideClass, u.masks.classMask >>> 0);
      gl.uniform1ui(P.u.hideRole, u.masks.roleMask >>> 0);
      gl.uniform1i(P.u.hideRoof, u.masks.hideRoofs ? 1 : 0);
      gl.uniform3fv(P.u.light, LIGHT);
      gl.uniform3f(P.u.target, u.target.x, u.target.y, u.target.z);
      gl.uniform1i(P.u.fade, u.fade ? 1 : 0);
      gl.uniform1f(P.u.fadeRadius, u.fadeRadius);
      gl.uniform1f(P.u.cutHeight, Number.isFinite(u.masks.cutHeight) ? u.masks.cutHeight : 1e30);
      gl.uniform1ui(P.u.selected, u.selected >>> 0);
      let boxMode = -1;
      for (let i = 0; i < list.n; i++) {
        const buf = buffers.get(list.buffer[i] ?? 0);
        if (!buf) continue;
        const count = list.count[i] ?? 0;
        const first = list.first[i] ?? 0;
        if (list.kind[i] === DRAW_MESH) {
          const m = meshes.get(list.mesh[i] ?? -1);
          if (!m) continue;
          if (boxMode !== 0) gl.uniform1i(P.u.box, (boxMode = 0));
          gl.bindVertexArray(m.vao);
          bindInstances(buf, first);
          gl.drawElementsInstanced(gl.TRIANGLES, m.indexCount, m.indexType, 0, count);
        } else {
          if (boxMode !== 1) gl.uniform1i(P.u.box, (boxMode = 1));
          gl.bindVertexArray(cube.vao);
          bindInstances(buf, first);
          gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, count);
        }
      }
      gl.bindVertexArray(null);
      // composite with outlines
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(P.composite);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.colour);
      gl.uniform1i(P.u.cColour, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, target.id);
      gl.uniform1i(P.u.cId, 1);
      gl.bindVertexArray(emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
    framebufferBytes: () => (target ? target.width * target.height * 12 : 0),
    sample(): FrameSample {
      if (lost || !target) return { width, height, drawnPixels: 0, distinctIds: 0 };
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      const ids = new Uint32Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, ids);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      let drawn = 0;
      const seen = new Set<number>();
      for (let k = 0; k < width * height; k++) {
        const id = ids[k * 4] ?? 0;
        if (id === 0) continue;
        drawn++;
        if (seen.size < 4096) seen.add(id);
      }
      return { width, height, drawnPixels: drawn, distinctIds: seen.size };
    },
    dispose(): void {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (!lost) {
        for (const m of meshes.keys()) this.deleteMesh(m);
        for (const h of [...buffers.keys()]) this.deleteInstanceBuffer(h);
        if (target) {
          gl.deleteFramebuffer(target.fbo);
          gl.deleteTexture(target.colour);
          gl.deleteTexture(target.id);
          gl.deleteRenderbuffer(target.depth);
        }
        gl.deleteProgram(programs.piece);
        gl.deleteProgram(programs.grid);
        gl.deleteProgram(programs.composite);
        gl.deleteVertexArray(cube.vao);
        gl.deleteVertexArray(emptyVao);
        gl.deleteBuffer(cube.vbo);
        gl.deleteBuffer(cube.ibo);
      }
      target = null;
      meshes.clear();
      buffers.clear();
    },
  };
}
