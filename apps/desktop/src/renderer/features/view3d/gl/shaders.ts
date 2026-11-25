/**
 * The viewer's three GLSL ES 3.00 programs.
 *
 * Pieces: one program for meshes and boxes (a unit cube stretched over each instance's own-frame box, then turned and
 * moved like its mesh; a summary box is placed at the origin unturned, so its box is the world box). Flat shading from
 * screen-space derivatives (no normals stored), with the software renderer's light and ambient
 * (lit = 0.34 + 0.66 |n·L|), so the viewer and the pictures Claude sees agree in colour. Hidden classes, roles and
 * roofs, and pieces under a pixel, collapse in the vertex shader; the cut height, water (60% shown) and the fade
 * between camera and target use a screen-door pattern in the fragment shader (no sorting). The fragment writes the
 * colour and the piece id (+1; 0 is nothing).
 *
 * Grid: the ground plane under the map with tile and 8-tile lines, drawn first as background.
 *
 * Composite: the colour target to the screen, darkened where the id changes (the software renderer's outline).
 */

export const PIECE_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aPlace;
layout(location = 2) in vec3 aMin;
layout(location = 3) in vec3 aMax;
layout(location = 4) in vec4 aColour;
layout(location = 5) in uint aFlags;
layout(location = 6) in uint aId;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uPxK;
uniform float uMinPx;
uniform bool uBox;
uniform uint uHideClass;
uniform bool uHideRoof;
out vec3 vWorld;
flat out vec3 vColour;
flat out uint vId;
flat out uint vFlags;
void main() {
  uint cls = aFlags & 15u;
  bool roof = ((aFlags >> 8u) & 1u) == 1u;
  bool hidden = ((uHideClass >> cls) & 1u) == 1u || (uHideRoof && roof);
  vec3 ext = aMax - aMin;
  float size = max(ext.x, max(ext.y, ext.z));
  float dist = max(distance(uEye, aPlace.xyz + (aMin + aMax) * 0.5) - size * 0.5, 0.001);
  if (hidden || size * uPxK / dist < uMinPx) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vWorld = vec3(0.0);
    vColour = vec3(0.0);
    vId = 0u;
    vFlags = 0u;
    return;
  }
  // a box stand-in is the unit cube over the mesh's own-frame bounds, turned and moved like the mesh
  vec3 local = uBox ? mix(aMin, aMax, aPos) : aPos;
  float t = radians(aPlace.w);
  float c = cos(t);
  float s = sin(t);
  vec3 w = vec3(local.x * c + local.z * s, local.y, -local.x * s + local.z * c) + aPlace.xyz;
  vWorld = w;
  vColour = aColour.rgb;
  vId = aId;
  vFlags = aFlags;
  gl_Position = uViewProj * vec4(w, 1.0);
}
`;

export const PIECE_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWorld;
flat in vec3 vColour;
flat in uint vId;
flat in uint vFlags;
uniform vec3 uLight;
uniform vec3 uEye;
uniform vec3 uTarget;
uniform bool uFade;
uniform float uFadeRadius;
uniform float uCutHeight;
uniform uint uSelected;
layout(location = 0) out vec4 oColour;
layout(location = 1) out uint oId;
void main() {
  if (vWorld.y > uCutHeight) discard;
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (((vFlags >> 9u) & 1u) == 1u && ((p.x + 2 * p.y) % 5) < 2) discard;
  if (uFade) {
    vec3 seg = uTarget - uEye;
    float t = dot(vWorld - uEye, seg) / max(dot(seg, seg), 1e-6);
    if (t > 0.0 && t < 0.9) {
      float r = distance(vWorld, uEye + seg * t);
      if (r < uFadeRadius * t && ((p.x & 1) + (p.y & 1)) != 0) discard;
    }
  }
  vec3 n = cross(dFdx(vWorld), dFdy(vWorld));
  float nl = length(n);
  float lit = nl > 0.0 ? 0.34 + 0.66 * abs(dot(n / nl, uLight)) : 1.0;
  vec3 c = vColour * lit;
  if (vId == uSelected) c = mix(c, vec3(0.83, 0.63, 0.34), 0.6);
  oColour = vec4(c, 1.0);
  oId = vId + 1u;
}
`;

export const GRID_VS = `#version 300 es
uniform mat4 uViewProj;
uniform vec4 uExtent;
uniform float uY;
out vec3 vWorld;
void main() {
  int i = gl_VertexID;
  // two triangles: 0 1 2, 2 1 3 over the corners (minX,minZ) (maxX,minZ) (minX,maxZ) (maxX,maxZ)
  int k = i < 3 ? i : (i == 3 ? 2 : (i == 4 ? 1 : 3));
  float x = (k & 1) == 0 ? uExtent.x : uExtent.y;
  float z = (k & 2) == 0 ? uExtent.z : uExtent.w;
  vWorld = vec3(x, uY, z);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
`;

export const GRID_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWorld;
uniform vec3 uBg;
layout(location = 0) out vec4 oColour;
layout(location = 1) out uint oId;
float lines(vec2 p) {
  vec2 w = fwidth(p);
  vec2 g = abs(fract(p - 0.5) - 0.5) / max(w, vec2(1e-5));
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  vec2 p = vWorld.xz;
  vec2 w = fwidth(p);
  float cellPx = 1.0 / max(max(w.x, w.y), 1e-5);
  float minor = lines(p) * clamp((cellPx - 3.0) / 9.0, 0.0, 1.0);
  float major = lines(p / 8.0) * clamp((cellPx * 8.0 - 3.0) / 9.0, 0.0, 1.0);
  vec3 ground = uBg * 1.18 + vec3(0.012);
  vec3 line = uBg * 1.9 + vec3(0.05);
  vec3 c = mix(ground, line, max(minor * 0.45, major * 0.8));
  oColour = vec4(c, 1.0);
  oId = 0u;
}
`;

export const COMPOSITE_VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uColour;
uniform highp usampler2D uId;
out vec4 oColour;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uColour, 0);
  vec3 c = texelFetch(uColour, p, 0).rgb;
  uint id = texelFetch(uId, p, 0).r;
  if (id != 0u) {
    uint r = p.x + 1 < size.x ? texelFetch(uId, p + ivec2(1, 0), 0).r : id;
    uint d = p.y > 0 ? texelFetch(uId, p - ivec2(0, 1), 0).r : id;
    uint l = p.x > 0 ? texelFetch(uId, p - ivec2(1, 0), 0).r : id;
    uint u = p.y + 1 < size.y ? texelFetch(uId, p + ivec2(0, 1), 0).r : id;
    if (r != id || d != id || l == 0u || u == 0u) c *= 0.62;
  }
  oColour = vec4(c, 1.0);
}
`;
