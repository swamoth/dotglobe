/**
 * The sphere pass. One triangle covers the screen. The fragment shader casts a ray at the unit
 * sphere, finds the nearest point of the Fibonacci lattice, and asks the land mask whether that
 * point is land.
 *
 * COBE (github.com/shuding/cobe, MIT) established this shape of solution. The lattice inverse is
 * from Keinert et al. (2015). The rest is this package: a perspective camera instead of an
 * orthographic disc, a separate tint map, and a dot edge that is antialiased with a derivative.
 */

import { program, texture, uniforms, upload, type TextureOptions } from './gl';
import { latticeSpacing } from './fibonacci';
import type { View } from './camera';

/** The index ladder in the shader decodes an index below 2^15. Keep the lattice under that. */
export const MAX_DOTS = 32000;

export interface SphereStyle {
  /** Lattice points on the sphere. More points means smaller dots. */
  dots: number;
  /** Dot radius as a fraction of the lattice spacing. */
  dotRatio: number;
  /** Exponent of the falloff of a dot toward the limb. */
  diffuse: number;
  /** Brightness floor for an ocean dot. 0 leaves the ocean empty. */
  oceanDots: number;
  /** Strength of the rim inside the disc. */
  rim: number;
  /** Width of the glow outside the disc, in globe radii. 0 removes it. */
  glowWidth: number;
  base: string;
  dot: string;
  glow: string;
}

export const DEFAULT_STYLE: SphereStyle = {
  dots: 24000,
  dotRatio: 0.27,
  diffuse: 1.5,
  oceanDots: 0,
  rim: 0.35,
  glowWidth: 0.35,
  base: '#151515',
  dot: '#e6e6e6',
  glow: '#c9cfd8',
};

const VERT = `#version 300 es
uniform vec3 uForward, uRight, uUp;
uniform float uFocal, uAspect;
out vec3 vRay;
void main() {
  // One triangle that covers the screen, built from the vertex index. No buffer needed.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vec2 ndc = p * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vRay = uForward + (uRight * ndc.x * uAspect + uUp * ndc.y) / uFocal;
}`;

const FRAG = `#version 300 es
precision highp float;

in vec3 vRay;
out vec4 fragColor;

uniform vec3 uCamPos;
uniform float uDots, uDotRadius, uDiffuse, uOceanDots, uRim, uGlowWidth;
uniform vec3 uBase, uDot, uGlow;
uniform sampler2D uLand, uTint;

const float SQRT5 = 2.236068;
const float PI = 3.141593;
const float TAU = 6.283185;
const float PHI = 1.618034;

/*
 * Nearest point of an n-point spherical Fibonacci lattice, in constant time.
 * The polar axis is z here, so the caller swizzles y and z. The seam then sits at the poles.
 */
vec3 nearestLattice(vec3 p, out float dist) {
  float byDots = 1.0 / uDots;
  float k = max(2.0, floor(log2(SQRT5 * uDots * PI * (1.0 - p.z * p.z)) * 0.72021));
  vec2 f = floor(pow(PHI, k) / SQRT5 * vec2(1.0, PHI) + 0.5);
  vec2 br1 = fract((f + 1.0) * (PHI - 1.0)) * TAU - 3.883222;
  vec2 br2 = -2.0 * f;
  vec2 sp = vec2(atan(p.y, p.x), p.z - 1.0);
  vec2 c = floor(vec2(br2.y * sp.x - br1.y * (sp.y * uDots + 1.0),
                     -br2.x * sp.x + br1.x * (sp.y * uDots + 1.0)) / (br1.x * br2.y - br2.x * br1.y));

  float best = PI;
  vec3 hit = vec3(0.0, 0.0, 1.0);
  for (float s = 0.0; s < 4.0; s += 1.0) {
    vec2 o = vec2(mod(s, 2.0), floor(s * 0.5));
    float idx = dot(f, c + o);
    if (idx > uDots || idx < 0.0) continue;

    // fract(idx * (PHI - 1.0)) without losing precision on a large index.
    float a = idx, b = 0.0;
    if (a >= 16384.0) { a -= 16384.0; b += 0.868872; }
    if (a >= 8192.0) { a -= 8192.0; b += 0.934436; }
    if (a >= 4096.0) { a -= 4096.0; b += 0.467218; }
    if (a >= 2048.0) { a -= 2048.0; b += 0.733609; }
    if (a >= 1024.0) { a -= 1024.0; b += 0.866804; }
    if (a >= 512.0) { a -= 512.0; b += 0.433402; }
    if (a >= 256.0) { a -= 256.0; b += 0.216701; }
    if (a >= 128.0) { a -= 128.0; b += 0.108351; }
    if (a >= 64.0) { a -= 64.0; b += 0.554175; }
    if (a >= 32.0) { a -= 32.0; b += 0.777088; }
    if (a >= 16.0) { a -= 16.0; b += 0.888544; }
    if (a >= 8.0) { a -= 8.0; b += 0.944272; }
    if (a >= 4.0) { a -= 4.0; b += 0.472136; }
    if (a >= 2.0) { a -= 2.0; b += 0.236068; }
    if (a >= 1.0) { a -= 1.0; b += 0.618034; }
    float theta = fract(b) * TAU;

    float cosphi = 1.0 - 2.0 * idx * byDots;
    float sinphi = sqrt(max(0.0, 1.0 - cosphi * cosphi));
    vec3 q = vec3(cos(theta) * sinphi, sin(theta) * sinphi, cosphi);
    float d = length(p - q);
    if (d < best) { best = d; hit = q; }
  }
  dist = best;
  return hit;
}

void main() {
  vec3 rd = normalize(vRay);
  float b = dot(uCamPos, rd);
  float c = dot(uCamPos, uCamPos) - 1.0;
  float disc = b * b - c;

  if (disc < 0.0) {
    // The ray misses. Draw the glow that sits outside the limb, then stop.
    float miss = sqrt(max(0.0, c + 1.0 - b * b)) - 1.0;
    float g = uGlowWidth > 0.0 ? pow(max(0.0, 1.0 - miss / uGlowWidth), 3.0) : 0.0;
    fragColor = vec4(uGlow * g * uRim, g);
    return;
  }

  vec3 p = uCamPos + rd * (-b - sqrt(disc));
  float dist;
  vec3 q = nearestLattice(p.xzy, dist).xzy;

  float lat = asin(clamp(q.y, -1.0, 1.0));
  float lng = PI * 0.5 - atan(q.z, q.x);
  vec2 uv = vec2(fract((lng + PI) / TAU), (PI * 0.5 - lat) / PI);

  float isLand = max(texture(uLand, uv).r, uOceanDots);
  vec4 tint = texture(uTint, uv);

  float nl = max(dot(p, normalize(uCamPos)), 0.0); // headlight, dim toward the limb
  float aa = fwidth(dist);
  float coverage = 1.0 - smoothstep(uDotRadius - aa, uDotRadius + aa, dist);
  float k = coverage * isLand * pow(nl, uDiffuse);

  vec3 color = uBase * (0.12 + 0.88 * pow(nl, 0.5))
             + mix(uDot, tint.rgb, tint.a) * k
             + pow(1.0 - nl, 4.0) * uGlow * uRim;
  fragColor = vec4(color, 1.0);
}`;

/** A hex color as three values in 0..1. Display values, with no color conversion. */
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface SpherePass {
  draw(v: View): void;
  setStyle(style: Partial<SphereStyle>): void;
  setLand(data: Uint8Array | null, width: number, height: number): void;
  setTint(data: Uint8Array | null, width: number, height: number): void;
  destroy(): void;
}

export function createSpherePass(gl: WebGL2RenderingContext, initial: Partial<SphereStyle> = {}): SpherePass {
  const style: SphereStyle = { ...DEFAULT_STYLE, ...initial };
  const prog = program(gl, VERT, FRAG);
  const u = uniforms(gl, prog);
  const vao = gl.createVertexArray()!; // WebGL2 needs a bound array object, even with no attribute

  const landFormat: TextureOptions = { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE };
  const tintFormat: TextureOptions = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  const land = texture(gl, landFormat);
  const tint = texture(gl, tintFormat);
  upload(gl, land, landFormat, new Uint8Array([0]), 1, 1);
  upload(gl, tint, tintFormat, new Uint8Array([0, 0, 0, 0]), 1, 1);

  return {
    draw(v) {
      gl.useProgram(prog);
      gl.bindVertexArray(vao);

      gl.uniform3fv(u.uCamPos, v.position);
      gl.uniform3fv(u.uForward, v.forward);
      gl.uniform3fv(u.uRight, v.right);
      gl.uniform3fv(u.uUp, v.up);
      gl.uniform1f(u.uFocal, v.focal);
      gl.uniform1f(u.uAspect, v.aspect);

      const dots = Math.min(MAX_DOTS, Math.max(100, Math.round(style.dots)));
      gl.uniform1f(u.uDots, dots);
      gl.uniform1f(u.uDotRadius, style.dotRatio * latticeSpacing(dots));
      gl.uniform1f(u.uDiffuse, style.diffuse);
      gl.uniform1f(u.uOceanDots, style.oceanDots);
      gl.uniform1f(u.uRim, style.rim);
      gl.uniform1f(u.uGlowWidth, style.glowWidth);
      gl.uniform3fv(u.uBase, rgb(style.base));
      gl.uniform3fv(u.uDot, rgb(style.dot));
      gl.uniform3fv(u.uGlow, rgb(style.glow));

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, land);
      gl.uniform1i(u.uLand, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tint);
      gl.uniform1i(u.uTint, 1);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
    setStyle(next) { Object.assign(style, next); },
    setLand(data, width, height) {
      upload(gl, land, landFormat, data ?? new Uint8Array([0]), data ? width : 1, data ? height : 1);
    },
    setTint(data, width, height) {
      upload(gl, tint, tintFormat, data ?? new Uint8Array([0, 0, 0, 0]), data ? width : 1, data ? height : 1);
    },
    destroy() {
      gl.deleteProgram(prog);
      gl.deleteVertexArray(vao);
      gl.deleteTexture(land);
      gl.deleteTexture(tint);
    },
  };
}
