/**
 * Arcs, drawn as instanced ribbons.
 *
 * One instanced draw call covers every arc. The vertex shader walks a triangle strip along the
 * great circle between the two ends, lifts it by a half sine, and offsets each side of the strip
 * perpendicular to the direction on the screen, so a ribbon keeps a constant width in pixels.
 *
 * The fragment shader casts a ray at the sphere and drops a fragment that the globe covers.
 * Because the test is analytic, an arc needs no depth buffer and cuts cleanly at the limb.
 */

import { program, texture, upload, type Program, type TextureOptions } from './gl';
import type { View } from './camera';
import { arcClearanceFor, centralAngle } from './geo';
import { rgb } from './sphere';

export interface Arc {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  /** Width in pixels. The default is 2. */
  stroke?: number;
  /**
   * Height above the surface at the middle of the arc, in globe radii. The default grows with
   * the distance, from 0.03 for a short hop to 0.15 for an antipodal route.
   */
  clearance?: number;
  /** A hex color. The default is white. */
  color?: string;
  /** Opacity in 0..1. The default is 1. */
  opacity?: number;
}

/** Texels across each data texture. */
const COLS = 1024;
/** Steps along one arc. A ribbon of 48 steps has no visible corner at any zoom this globe allows. */
const SEGMENTS = 48;

const VERT = `#version 300 es
precision highp float;

uniform vec3 uCamPos, uForward, uRight, uUp;
uniform float uFocal, uAspect;
uniform vec2 uViewport;
uniform sampler2D uEnds;
uniform sampler2D uStyle;
uniform sampler2D uColor;
uniform int uCols, uSegments;

out vec4 vColor;
out vec3 vWorld;

const float PI = 3.141593;

vec3 place(float lat, float lng) {
  float phi = (90.0 - lat) * PI / 180.0;
  float theta = (90.0 - lng) * PI / 180.0;
  return vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
}

/** Screen position in normalized device coordinates, and the depth along the view direction. */
vec3 toScreen(vec3 world) {
  vec3 rel = world - uCamPos;
  float z = dot(rel, uForward);
  return vec3(dot(rel, uRight) / z * uFocal / uAspect, dot(rel, uUp) / z * uFocal, z);
}

void main() {
  ivec2 at = ivec2(gl_InstanceID % uCols, gl_InstanceID / uCols);
  vec4 ends = texelFetch(uEnds, at, 0);
  vec4 style = texelFetch(uStyle, at, 0);
  vColor = texelFetch(uColor, at, 0);

  int seg = gl_VertexID >> 1;
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  float steps = float(uSegments);
  float t = float(seg) / steps;

  vec3 a = place(ends.x, ends.y);
  vec3 b = place(ends.z, ends.w);
  float omega = acos(clamp(dot(a, b), -1.0, 1.0));
  float sinOmega = sin(omega);

  // Two points: this one, and the next along the arc. The pair gives the direction on screen.
  float t2 = min(t + 1.0 / steps, 1.0);
  vec3 p1, p2;
  if (sinOmega < 1e-6) {
    p1 = a;             // the two ends are the same place
    p2 = a;
  } else {
    p1 = (sin((1.0 - t) * omega) * a + sin(t * omega) * b) / sinOmega;
    p2 = (sin((1.0 - t2) * omega) * a + sin(t2 * omega) * b) / sinOmega;
  }
  // A half sine is 0 at both ends and never negative, thus an arc never cuts into the sphere.
  vec3 w1 = p1 * (1.0 + style.x * sin(PI * t));
  vec3 w2 = p2 * (1.0 + style.x * sin(PI * t2));
  vWorld = w1;

  vec3 s1 = toScreen(w1);
  vec3 s2 = toScreen(w2);
  if (s1.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // behind the camera

  // Work in pixels, so the ribbon keeps one width everywhere, then go back to device coordinates.
  vec2 px1 = s1.xy * uViewport * 0.5;
  vec2 px2 = s2.xy * uViewport * 0.5;
  vec2 dir = px2 - px1;
  vec2 tangent = length(dir) < 1e-6 ? vec2(1.0, 0.0) : normalize(dir);
  vec2 offset = vec2(-tangent.y, tangent.x) * side * style.y * 0.5;

  gl_Position = vec4((px1 + offset) / (uViewport * 0.5), 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

uniform vec3 uCamPos;
in vec4 vColor;
in vec3 vWorld;
out vec4 fragColor;

void main() {
  /*
   * Does the globe cover this fragment? Solve the ray from the camera against the unit sphere.
   * A hit before the fragment means the sphere is in front, thus drop the fragment. Testing each
   * fragment, rather than each vertex, cuts the ribbon exactly at the limb.
   */
  vec3 rel = vWorld - uCamPos;
  float len = length(rel);
  vec3 rd = rel / len;
  float b = dot(uCamPos, rd);
  float disc = b * b - (dot(uCamPos, uCamPos) - 1.0);
  if (disc > 0.0) {
    float t = -b - sqrt(disc);
    if (t > 0.0 && t < len - 1e-4) discard;
  }
  fragColor = vec4(vColor.rgb * vColor.a, vColor.a); // premultiplied
}`;

export interface ArcPass {
  /** Draws every arc. Returns false while the driver is still linking the shader. */
  draw(v: View, viewport: [number, number]): boolean;
  set(arcs: readonly Arc[]): void;
  readonly count: number;
  destroy(): void;
}

export function createArcPass(gl: WebGL2RenderingContext): ArcPass {
  const prog: Program = program(gl, VERT, FRAG);
  const vao = gl.createVertexArray()!;

  const floatFormat: TextureOptions = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
  const colorFormat: TextureOptions = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  const ends = texture(gl, floatFormat);
  const style = texture(gl, floatFormat);
  const color = texture(gl, colorFormat);

  let count = 0;
  upload(gl, ends, floatFormat, new Float32Array(4), 1, 1);
  upload(gl, style, floatFormat, new Float32Array(4), 1, 1);
  upload(gl, color, colorFormat, new Uint8Array(4), 1, 1);

  return {
    get count() { return count; },
    draw(v, viewport) {
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
      gl.uniform2f(u.uViewport, viewport[0], viewport[1]);
      gl.uniform1i(u.uCols, COLS);
      gl.uniform1i(u.uSegments, SEGMENTS);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ends);
      gl.uniform1i(u.uEnds, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, style);
      gl.uniform1i(u.uStyle, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, color);
      gl.uniform1i(u.uColor, 2);

      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (SEGMENTS + 1) * 2, count);
      gl.bindVertexArray(null);
      return true;
    },
    set(arcs) {
      count = arcs.length;
      if (count === 0) return;
      const rows = Math.ceil(count / COLS);
      const cells = COLS * rows;
      const e = new Float32Array(cells * 4);
      const s = new Float32Array(cells * 4);
      const c = new Uint8Array(cells * 4);
      for (let i = 0; i < count; i++) {
        const arc = arcs[i];
        e[i * 4] = arc.startLat;
        e[i * 4 + 1] = arc.startLng;
        e[i * 4 + 2] = arc.endLat;
        e[i * 4 + 3] = arc.endLng;
        s[i * 4] = arc.clearance ?? arcClearanceFor(centralAngle(
          { lat: arc.startLat, lng: arc.startLng },
          { lat: arc.endLat, lng: arc.endLng },
        ));
        s[i * 4 + 1] = arc.stroke ?? 2;
        const [r, g, b] = arc.color ? rgb(arc.color) : [1, 1, 1];
        c[i * 4] = r * 255;
        c[i * 4 + 1] = g * 255;
        c[i * 4 + 2] = b * 255;
        c[i * 4 + 3] = (arc.opacity ?? 1) * 255;
      }
      upload(gl, ends, floatFormat, e, COLS, rows);
      upload(gl, style, floatFormat, s, COLS, rows);
      upload(gl, color, colorFormat, c, COLS, rows);
    },
    destroy() {
      prog.destroy();
      gl.deleteVertexArray(vao);
      gl.deleteTexture(ends);
      gl.deleteTexture(style);
      gl.deleteTexture(color);
    },
  };
}
