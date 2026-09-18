/**
 * Markers, drawn as instanced quads that read their place from a data texture.
 *
 * Nothing about a marker lives in a vertex buffer. One instanced draw call covers every marker,
 * and the vertex shader fetches the marker it draws by its instance number. A change to the set
 * is one texture upload, and the count has no cap beyond texture size.
 *
 * The shader hides a marker that the globe covers, with the same ray-sphere test that
 * `camera.project` runs on the CPU, so the screen and `project()` always agree.
 */

import { program, texture, upload, type Program, type TextureOptions } from './gl';
import type { View } from './camera';
import { rgb } from './sphere';

export interface Marker {
  lat: number;
  lng: number;
  /** Radius in globe radii. The default is 0.01. */
  size?: number;
  /** Height above the surface, in globe radii. The default is 0. */
  altitude?: number;
  /** A hex color, for example '#ff5533'. The default is white. */
  color?: string;
  /** Opacity in 0..1. The default is 1. */
  opacity?: number;
  /** The default is a dot. */
  shape?: 'dot' | 'ring' | 'square' | 'diamond';
  /** Text for a tooltip on hover. */
  title?: string;
}

const SHAPES = { dot: 0, ring: 1, square: 2, diamond: 3 };

/** Texels across the data texture. A taller texture holds more markers. */
const COLS = 1024;

const VERT = `#version 300 es
precision highp float;

uniform vec3 uCamPos, uForward, uRight, uUp;
uniform float uFocal, uAspect;
uniform sampler2D uData;
uniform sampler2D uColor;
uniform int uCols;

out vec2 vCorner;
out vec4 vColor;
out float vShape;

const float PI = 3.141593;

void main() {
  ivec2 at = ivec2(gl_InstanceID % uCols, gl_InstanceID / uCols);
  vec4 d = texelFetch(uData, at, 0);
  vColor = texelFetch(uColor, at, 0);
  // The shape rides in the altitude channel as tens, because an altitude never reaches 10.
  vShape = floor(d.w / 10.0);
  d.w -= vShape * 10.0;

  // The corners of the quad, in strip order.
  vCorner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;

  // Place: y is up, the prime meridian faces +z. This matches geo.unitVector.
  float phi = (90.0 - d.x) * PI / 180.0;
  float theta = (90.0 - d.y) * PI / 180.0;
  float r = 1.0 + d.w;
  vec3 world = vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta)) * r;

  vec3 rel = world - uCamPos;
  float z = dot(rel, uForward);
  if (z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // behind the camera

  /*
   * Does the globe cover this marker? Solve the ray from the camera against the unit sphere. A
   * hit before the marker means the marker sits behind the globe. This is exact for a marker on
   * the surface and for one above it.
   */
  float len = length(rel);
  vec3 rd = rel / len;
  float b = dot(uCamPos, rd);
  float disc = b * b - (dot(uCamPos, uCamPos) - 1.0);
  if (disc > 0.0) {
    float t = -b - sqrt(disc);
    if (t > 0.0 && t < len - 1e-4) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  }

  vec2 center = vec2(dot(rel, uRight) / z * uFocal / uAspect, dot(rel, uUp) / z * uFocal);
  vec2 radius = vec2(d.z / z * uFocal / uAspect, d.z / z * uFocal);
  gl_Position = vec4(center + vCorner * radius, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 vCorner;
in vec4 vColor;
in float vShape;
out vec4 fragColor;

void main() {
  // A shape from a square quad, as a distance field. The derivative keeps every edge one pixel
  // wide at any size. 0 dot, 1 ring, 2 square, 3 diamond.
  int shape = int(vShape + 0.5);
  float d = shape == 2 ? max(abs(vCorner.x), abs(vCorner.y))
          : shape == 3 ? abs(vCorner.x) + abs(vCorner.y)
          : length(vCorner);
  float aa = fwidth(d);
  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  if (shape == 1) alpha *= smoothstep(0.62 - aa, 0.62, d); // hollow, with a wall about 0.38 wide
  alpha *= vColor.a;
  if (alpha <= 0.0) discard;
  fragColor = vec4(vColor.rgb * alpha, alpha); // premultiplied
}`;

export interface MarkerPass {
  /** Draws every marker. Returns false while the driver is still linking the shader. */
  draw(v: View): boolean;
  set(markers: readonly Marker[]): void;
  readonly count: number;
  destroy(): void;
}

export function createMarkerPass(gl: WebGL2RenderingContext): MarkerPass {
  const prog: Program = program(gl, VERT, FRAG);
  const vao = gl.createVertexArray()!;

  const dataFormat: TextureOptions = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
  const colorFormat: TextureOptions = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  const data = texture(gl, dataFormat);
  const color = texture(gl, colorFormat);

  let count = 0;
  let rows = 1;
  upload(gl, data, dataFormat, new Float32Array(4), 1, 1);
  upload(gl, color, colorFormat, new Uint8Array(4), 1, 1);

  return {
    get count() { return count; },
    draw(v) {
      if (count === 0) return true;
      if (!prog.ready()) return false;
      const u = prog.uniforms;
      gl.useProgram(prog.handle);
      gl.bindVertexArray(vao);

      gl.uniform3fv(u.uCamPos, v.position);
      gl.uniform3fv(u.uForward, v.forward);
      gl.uniform3fv(u.uRight, v.right);
      gl.uniform3fv(u.uUp, v.up);
      gl.uniform1f(u.uFocal, v.focal);
      gl.uniform1f(u.uAspect, v.aspect);
      gl.uniform1i(u.uCols, COLS);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, data);
      gl.uniform1i(u.uData, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, color);
      gl.uniform1i(u.uColor, 1);

      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.bindVertexArray(null);
      return true;
    },
    set(markers) {
      count = markers.length;
      if (count === 0) return;
      rows = Math.ceil(count / COLS);
      const cells = COLS * rows;
      const d = new Float32Array(cells * 4);
      const c = new Uint8Array(cells * 4);
      for (let i = 0; i < count; i++) {
        const m = markers[i];
        d[i * 4] = m.lat;
        d[i * 4 + 1] = m.lng;
        d[i * 4 + 2] = m.size ?? 0.01;
        d[i * 4 + 3] = (m.altitude ?? 0) + SHAPES[m.shape ?? 'dot'] * 10;
        const [r, g, b] = m.color ? rgb(m.color) : [1, 1, 1];
        c[i * 4] = r * 255;
        c[i * 4 + 1] = g * 255;
        c[i * 4 + 2] = b * 255;
        c[i * 4 + 3] = (m.opacity ?? 1) * 255;
      }
      upload(gl, data, dataFormat, d, COLS, rows);
      upload(gl, color, colorFormat, c, COLS, rows);
    },
    destroy() {
      prog.destroy();
      gl.deleteVertexArray(vao);
      gl.deleteTexture(data);
      gl.deleteTexture(color);
    },
  };
}
