/**
 * Rings: circles that grow outward from a place and fade as they go.
 *
 * A ring is drawn in the fragment shader, not as geometry. The vertex shader puts a quad over the
 * patch of sphere the ring can reach, and each fragment casts a ray at the sphere, measures the
 * angle from the center of the ring, and lights the band at the current radius. On a sphere seen
 * in perspective a ring is an ellipse, and this draws the exact one without tessellating it.
 *
 * The same ray-sphere hit that finds the angle also hides the far side, so a ring needs no depth
 * buffer, the same as every other pass here.
 */

import { program, texture, upload, type Program, type TextureOptions } from './gl';
import type { View } from './camera';
import { rgb } from './sphere';

export interface Ring {
  lat: number;
  lng: number;
  /** Angular radius the ring grows to, in degrees. The default is 5. */
  maxRadius?: number;
  /** Seconds for one pulse to travel from the center to `maxRadius`. The default is 3. */
  period?: number;
  /** Width of the band, in degrees. The default is 0.8. */
  width?: number;
  /** Pulses in flight at once, evenly spread over the period. The default is 1. */
  waves?: number;
  /** A hex color. The default is white. */
  color?: string;
  /** Opacity of a pulse as it leaves the center. The default is 1. */
  opacity?: number;
}

const COLS = 1024;

const VERT = `#version 300 es
precision highp float;

uniform vec3 uCamPos, uForward, uRight, uUp;
uniform float uFocal, uAspect;
uniform sampler2D uData;
uniform sampler2D uColor;
uniform int uCols;

out vec3 vRay;
out vec3 vCenter;
out vec4 vColor;
out vec3 vShape; // maxRadius, width, waves, all in radians except the count

const float PI = 3.141593;

void main() {
  ivec2 at = ivec2(gl_InstanceID % uCols, gl_InstanceID / uCols);
  vec4 d = texelFetch(uData, at, 0);
  vColor = texelFetch(uColor, at, 0);
  vShape = vec3(radians(d.z), radians(d.w), 1.0);

  float phi = (90.0 - d.x) * PI / 180.0;
  float theta = (90.0 - d.y) * PI / 180.0;
  vCenter = vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));

  /*
   * A quad that covers every place the ring can reach. The farthest point is maxRadius away on
   * the sphere, so a half-width of sin(maxRadius) around the center bounds it, and one more
   * band width covers the thickness. The quad faces the camera, so it holds at any angle.
   */
  float reach = sin(min(radians(d.z) + radians(d.w), PI * 0.5)) + radians(d.w);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;

  vec3 rel = vCenter - uCamPos;
  float z = dot(rel, uForward);
  if (z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vRay = vec3(0.0); return; }

  vec2 center = vec2(dot(rel, uRight) / z * uFocal / uAspect, dot(rel, uUp) / z * uFocal);
  vec2 radius = vec2(reach / z * uFocal / uAspect, reach / z * uFocal);
  vec2 ndc = center + corner * radius;
  gl_Position = vec4(ndc, 0.0, 1.0);

  // The ray through this corner, so the fragment can find its own point on the sphere.
  vRay = uForward + (uRight * ndc.x * uAspect + uUp * ndc.y) / uFocal;
}`;

const FRAG = `#version 300 es
precision highp float;

uniform vec3 uCamPos;
uniform float uTime;

in vec3 vRay;
in vec3 vCenter;
in vec4 vColor;
in vec3 vShape;
out vec4 fragColor;

void main() {
  vec3 rd = normalize(vRay);
  float b = dot(uCamPos, rd);
  float c = dot(uCamPos, uCamPos) - 1.0;
  float disc = b * b - c;
  if (disc < 0.0) discard; // the ray misses the globe

  // The near face. Using it means the far side of the sphere never shows a ring.
  vec3 p = uCamPos + rd * (-b - sqrt(disc));
  float angle = acos(clamp(dot(p, vCenter), -1.0, 1.0));

  float maxRadius = vShape.x;
  float width = vShape.y;
  if (angle > maxRadius + width) discard;

  // One pulse travels from 0 to maxRadius over the period. uTime already holds the phase.
  float radius = fract(uTime) * maxRadius;
  float edge = abs(angle - radius);
  float band = 1.0 - smoothstep(0.0, width, edge);
  if (band <= 0.0) discard;

  // Fade as the pulse leaves the center, so it dissolves instead of stopping.
  float fade = 1.0 - radius / maxRadius;
  float alpha = band * fade * vColor.a;
  if (alpha <= 0.0) discard;
  fragColor = vec4(vColor.rgb * alpha, alpha); // premultiplied
}`;

export interface RingPass {
  /** Draws every ring. `seconds` advances the pulses. */
  draw(v: View, seconds: number): boolean;
  set(rings: readonly Ring[]): void;
  readonly count: number;
  destroy(): void;
}

export function createRingPass(gl: WebGL2RenderingContext): RingPass {
  const prog: Program = program(gl, VERT, FRAG);
  const vao = gl.createVertexArray()!;

  const dataFormat: TextureOptions = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
  const colorFormat: TextureOptions = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  const data = texture(gl, dataFormat);
  const color = texture(gl, colorFormat);

  let count = 0;
  let period = 3;
  upload(gl, data, dataFormat, new Float32Array(4), 1, 1);
  upload(gl, color, colorFormat, new Uint8Array(4), 1, 1);

  return {
    get count() { return count; },
    draw(v, seconds) {
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
      gl.uniform1f(u.uTime, seconds / period);
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
    set(rings) {
      count = rings.length;
      if (count === 0) return;
      period = rings[0].period ?? 3;
      const rows = Math.ceil(count / COLS);
      const cells = COLS * rows;
      const d = new Float32Array(cells * 4);
      const c = new Uint8Array(cells * 4);
      for (let i = 0; i < count; i++) {
        const r = rings[i];
        d[i * 4] = r.lat;
        d[i * 4 + 1] = r.lng;
        d[i * 4 + 2] = r.maxRadius ?? 5;
        d[i * 4 + 3] = r.width ?? 0.8;
        const [red, green, blue] = r.color ? rgb(r.color) : [1, 1, 1];
        c[i * 4] = red * 255;
        c[i * 4 + 1] = green * 255;
        c[i * 4 + 2] = blue * 255;
        c[i * 4 + 3] = (r.opacity ?? 1) * 255;
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
