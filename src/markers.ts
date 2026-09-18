/**
 * Markers, drawn as instanced quads that read their place from a data texture.
 *
 * Nothing about a marker lives in a vertex buffer. One instanced draw call covers every marker,
 * and the vertex shader fetches the marker it draws by its instance number. A change to the set
 * is one texture upload, and the count has no cap beyond texture size.
 *
 * The shader hides a marker that the globe covers, with the same ray-sphere test that
 * `camera.project` runs on the CPU, so the screen and `project()` always agree.
 *
 * A transition keeps the last set in a second pair of textures, and the shader mixes the two by
 * a uniform that runs from 0 to 1. A marker moves, grows, and recolors on the GPU, and the CPU
 * uploads nothing while it does.
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
uniform sampler2D uPrevData;
uniform sampler2D uPrevColor;
uniform float uMix; // 1 draws the current set, less mixes in the last one
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
  if (uMix < 1.0) {
    vec4 p = texelFetch(uPrevData, at, 0);
    p.w -= floor(p.w / 10.0) * 10.0;
    d = mix(p, d, uMix);
    vColor = mix(texelFetch(uPrevColor, at, 0), vColor, uMix);
  }

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
  /** Draws every marker. `seconds` is the globe clock, for a transition. */
  draw(v: View, seconds: number): boolean;
  /**
   * Replace the set. With `transition` above 0, each marker moves from the one at its index in
   * the last set over that many milliseconds, from `now` on the globe clock. A new marker grows
   * in, and a removed one shrinks out.
   */
  set(markers: readonly Marker[], now?: number, transition?: number): void;
  readonly count: number;
  /** Globe clock in seconds when the transition ends. -Infinity for none. */
  readonly until: number;
  destroy(): void;
}

export function createMarkerPass(gl: WebGL2RenderingContext): MarkerPass {
  const prog: Program = program(gl, VERT, FRAG);
  const vao = gl.createVertexArray()!;

  const dataFormat: TextureOptions = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
  const colorFormat: TextureOptions = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  const data = texture(gl, dataFormat);
  const color = texture(gl, colorFormat);
  const prevData = texture(gl, dataFormat);
  const prevColor = texture(gl, colorFormat);

  let count = 0; // markers in the current set
  let drawn = 0; // instances to draw, which includes markers that shrink out
  let rows = 1;
  let last: { d: Float32Array; c: Uint8Array; count: number } | null = null; // the CPU copy of the current set
  let start = 0, length = 0; // the transition, in globe clock seconds
  upload(gl, data, dataFormat, new Float32Array(4), 1, 1);
  upload(gl, color, colorFormat, new Uint8Array(4), 1, 1);

  return {
    get count() { return count; },
    get until() { return length > 0 ? start + length : -Infinity; },
    draw(v, seconds) {
      if (drawn === 0) return true;
      if (!prog.ready()) return false;
      const u = prog.uniforms;
      gl.useProgram(prog.handle);
      gl.bindVertexArray(vao);

      // Ease the mix in and out. Past the end the shader reads the current set alone.
      let mix = 1;
      if (length > 0) {
        const t = Math.min(1, Math.max(0, (seconds - start) / length));
        mix = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        if (t >= 1) { length = 0; drawn = count; }
      }
      gl.uniform1f(u.uMix, mix);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, prevData);
      gl.uniform1i(u.uPrevData, 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, prevColor);
      gl.uniform1i(u.uPrevColor, 3);

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

      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, drawn);
      gl.bindVertexArray(null);
      return true;
    },
    set(markers, now = 0, transition = 0) {
      count = markers.length;
      const before = last;
      // During a transition the pass draws the larger of the two sets. A marker that the new set
      // lacks keeps its place and shrinks to nothing, and one the old set lacks grows from nothing.
      drawn = transition > 0 && before ? Math.max(count, before.count) : count;
      length = 0;
      if (drawn === 0) { last = null; return; }
      rows = Math.ceil(drawn / COLS);
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
      if (transition > 0 && before) {
        // The last set, in the new layout. Beyond its own count it copies the new marker at
        // size 0, so the marker grows in place. A removed marker gets its old data at size 0 in
        // the new set, so it shrinks in place. Longitude takes the short way around.
        const p = new Float32Array(cells * 4);
        const pc = new Uint8Array(cells * 4);
        p.set(before.d.subarray(0, Math.min(before.d.length, p.length)));
        pc.set(before.c.subarray(0, Math.min(before.c.length, pc.length)));
        for (let i = 0; i < drawn; i++) {
          if (i >= before.count) { p.set(d.subarray(i * 4, i * 4 + 4), i * 4); p[i * 4 + 2] = 0; pc.set(c.subarray(i * 4, i * 4 + 4), i * 4); }
          if (i >= count) { d.set(p.subarray(i * 4, i * 4 + 4), i * 4); d[i * 4 + 2] = 0; c.set(pc.subarray(i * 4, i * 4 + 4), i * 4); }
          const dl = d[i * 4 + 1] - p[i * 4 + 1];
          if (dl > 180) p[i * 4 + 1] += 360; else if (dl < -180) p[i * 4 + 1] -= 360;
          p[i * 4 + 3] = (p[i * 4 + 3] % 10) + Math.floor(d[i * 4 + 3] / 10) * 10; // the new shape
        }
        upload(gl, prevData, dataFormat, p, COLS, rows);
        upload(gl, prevColor, colorFormat, pc, COLS, rows);
        start = now;
        length = transition / 1000;
      }
      upload(gl, data, dataFormat, d, COLS, rows);
      upload(gl, color, colorFormat, c, COLS, rows);
      last = { d, c, count };
    },
    destroy() {
      prog.destroy();
      gl.deleteVertexArray(vao);
      gl.deleteTexture(data);
      gl.deleteTexture(color);
      gl.deleteTexture(prevData);
      gl.deleteTexture(prevColor);
    },
  };
}
