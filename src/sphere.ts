/**
 * The sphere pass. One triangle covers the screen. The fragment shader casts a ray at the unit
 * sphere, finds the nearest point of the Fibonacci lattice, and asks the land mask whether that
 * point is land.
 *
 * COBE (github.com/shuding/cobe, MIT) established this shape of solution. The lattice inverse is
 * from Keinert et al. (2015). The rest is this package: a perspective camera instead of an
 * orthographic disc, a separate tint map, and a dot edge that is antialiased with a derivative.
 */

import { program, texture, upload, type TextureOptions } from './gl';
import { latticeSpacing, unitVector } from './fibonacci';
import type { View } from './camera';

/**
 * Upper bound on the lattice. Every product in the shader that needs the fractional part of a
 * large number uses exact 32-bit integer math, so the count is bounded by float32 elsewhere:
 * uDots - 2 * idx must stay exact, which holds below 2^24. Measured exact at every latitude to
 * 8 million points. Past the altitude where this binds, the dots spread apart.
 */
export const MAX_DOTS = 8000000;

export interface SphereStyle {
  /**
   * Target distance between two neighboring dots, in CSS pixels. The lattice grows as the camera
   * moves in, so a dot keeps its size on screen and a coastline gains detail. Set it to 0 to fix
   * the lattice at `dots` instead.
   */
  dotPitch: number;
  /** Lattice points on the sphere, when `dotPitch` is 0. More points means smaller dots. */
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
  /** How dark the night side is, 0 to 1. 0 turns the terminator off. */
  night: number;
  /** Degrees between graticule lines. 0 draws none. */
  graticule: number;
  graticuleColor: string;
  /** Opacity of a graticule line, 0 to 1. */
  graticuleOpacity: number;
  /**
   * Color for per-dot data. One color: a dot mixes from `dot` toward it with its value. A list:
   * a color ramp from value 0 to 1, for example ['#1a1c2c', '#f4f1de', '#ff7a45'].
   */
  dataColor: string | string[];
  base: string;
  dot: string;
  glow: string;
}

export const DEFAULT_STYLE: SphereStyle = {
  dotPitch: 7,
  dots: 24000,
  dotRatio: 0.27,
  diffuse: 1.5,
  // A faint ocean dot. With 0 the ocean is empty, and a view of the Pacific is a bare disc.
  oceanDots: 0.07,
  rim: 0.3,
  glowWidth: 0.18,
  night: 0,
  graticule: 0,
  graticuleColor: '#9aa3b0',
  graticuleOpacity: 0.25,
  dataColor: '#ff7a45',
  base: '#121316',
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
uniform float uDots, uDotRadius, uDiffuse, uOceanDots, uRim, uGlowWidth, uNight;
uniform vec3 uSun;
uniform float uGraticule, uGraticuleOpacity;
uniform vec3 uGraticuleColor, uDataColor;
uniform sampler2D uRamp;
uniform int uUseRamp;
uniform sampler2D uData;
uniform int uDataCols; // 0 when no per-dot data is set
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
vec3 nearestLattice(vec3 p, out float dist, out float index) {
  float byDots = 1.0 / uDots;
  float k = max(2.0, floor(log2(SQRT5 * uDots * PI * (1.0 - p.z * p.z)) * 0.72021));
  vec2 f = floor(pow(PHI, k) / SQRT5 * vec2(1.0, PHI) + 0.5);
  /*
   * fract((f + 1) * (PHI - 1)), exactly, with the same unsigned multiply that theta uses below.
   * In float32 the product is a number near 400 whose fractional part has a resolution of about
   * 3e-5. That error goes through a determinant that is near 12 for some k, and comes out as
   * more than one whole lattice cell, so a band of latitude found no nearest point and went dark.
   */
  vec2 br1 = vec2((uvec2(f) + 1u) * 2654435769u) * (TAU / 4294967296.0) - 3.883222;
  vec2 br2 = -2.0 * f;
  vec2 sp = vec2(atan(p.y, p.x), p.z - 1.0);
  vec2 c = floor(vec2(br2.y * sp.x - br1.y * (sp.y * uDots + 1.0),
                     -br2.x * sp.x + br1.x * (sp.y * uDots + 1.0)) / (br1.x * br2.y - br2.x * br1.y));

  float best = PI;
  vec3 hit = vec3(0.0, 0.0, 1.0);
  index = 0.0;
  // An integer loop with a fixed count unrolls cleanly. A float loop that skips an iteration
  // makes the platform compiler emit dynamic flow control, which costs compile time.
  // clamp keeps an out-of-range candidate inside the lattice. Index 0 and index n are both real
  // lattice points, at the poles, thus a clamped candidate can only win when it is truly nearest.
  for (int s = 0; s < 4; ++s) {
    vec2 o = vec2(float(s & 1), float(s >> 1));
    float idx = clamp(dot(f, c + o), 0.0, uDots);

    /*
     * fract(idx * (PHI - 1.0)), exactly.
     *
     * A float cannot hold that product for a large index: 24 bits of mantissa go to the integer
     * part first, and the fraction is what remains. WebGL1 needs a ladder of 15 branches to keep
     * the precision. WebGL2 has integer arithmetic, and an unsigned multiply wraps modulo 2^32,
     * which is the fractional part in 32-bit fixed point. PHI - 1 scaled by 2^32 is 2654435769.
     */
    float theta = float(uint(idx) * 2654435769u) * (TAU / 4294967296.0);

    /*
     * cosphi, without the cancellation.
     *
     * Written as 1.0 - 2.0 * idx / n, the quotient approaches 1 near the equator and the
     * subtraction throws away most of the mantissa, so two neighboring indices land on the same
     * value and the lattice dissolves. uDots and idx are both whole numbers below 2^24, thus
     * uDots - 2.0 * idx is exact, and the single divide that follows keeps full precision.
     */
    float cosphi = (uDots - 2.0 * idx) * byDots;
    float sinphi = sqrt(max(0.0, 1.0 - cosphi * cosphi));
    vec3 q = vec3(cos(theta) * sinphi, sin(theta) * sinphi, cosphi);
    float d = length(p - q);
    if (d < best) { best = d; hit = q; index = idx; }
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
    float g = uGlowWidth > 0.0 ? pow(max(0.0, 1.0 - miss / uGlowWidth), 4.0) : 0.0;
    fragColor = vec4(uGlow * g * uRim, g);
    return;
  }

  vec3 p = uCamPos + rd * (-b - sqrt(disc));
  float dist, index;
  vec3 q = nearestLattice(p.xzy, dist, index).xzy;

  float lat = asin(clamp(q.y, -1.0, 1.0));
  float lng = PI * 0.5 - atan(q.z, q.x);
  vec2 uv = vec2(fract((lng + PI) / TAU), (PI * 0.5 - lat) / PI);

  float isLand = max(texture(uLand, uv).r, uOceanDots);
  vec4 tint = texture(uTint, uv);

  // Per-dot data. A value in 0..1 for this lattice index scales the dot from 0.55 to 1.45 times
  // its radius and sets its color. A dot with data shows over the ocean too.
  float value = 0.0;
  float radius = uDotRadius;
  if (uDataCols > 0) {
    int i = int(index);
    value = texelFetch(uData, ivec2(i % uDataCols, i / uDataCols), 0).r;
    radius *= 0.55 + 0.9 * value;
    isLand = max(isLand, step(0.001, value));
  }

  float nl = max(dot(p, normalize(uCamPos)), 0.0); // headlight, dim toward the limb
  float aa = fwidth(dist);
  float coverage = 1.0 - smoothstep(radius - aa, radius + aa, dist);
  float k = coverage * isLand * pow(nl, uDiffuse);

  /*
   * Shade the body linearly in nl. A curve such as pow(nl, 0.5) reaches full brightness a short
   * way in from the limb, which paints most of the disc one flat shade and leaves a dark band at
   * the edge. Linear limb darkening runs across the whole disc, so the sphere reads as round.
   */
  vec3 color = uBase * (0.25 + 0.75 * nl)
             + mix(uUseRamp > 0 ? texture(uRamp, vec2(value, 0.5)).rgb : mix(uDot, uDataColor, value), tint.rgb, tint.a) * k
             // A thin edge highlight. A wide one reads as a ring sitting inside the silhouette.
             + pow(1.0 - nl, 10.0) * uGlow * uRim;
  if (uGraticule > 0.0) {
    // Distance in degrees to the nearest line of latitude and of longitude, antialiased with
    // the screen-space derivative so a line stays about one pixel wide at any zoom.
    vec2 deg = vec2(degrees(asin(clamp(p.y, -1.0, 1.0))), degrees(PI * 0.5 - atan(p.z, p.x)));
    vec2 toLine = abs(fract(deg / uGraticule + 0.5) - 0.5) * uGraticule;
    vec2 w = fwidth(deg) * 0.75;
    float line = max(1.0 - smoothstep(0.0, w.x, toLine.x), 1.0 - smoothstep(0.0, w.y, toLine.y));
    color = mix(color, uGraticuleColor, line * uGraticuleOpacity * nl);
  }

  // Night. The terminator is a soft band, the width of twilight, around the plane at right
  // angles to the sun. The glow outside the disc is left alone.
  float day = smoothstep(-0.12, 0.12, dot(p, uSun));
  color *= mix(1.0 - uNight, 1.0, day);
  fragColor = vec4(color, 1.0);
}`;

/** A hex color as three values in 0..1. Display values, with no color conversion. */
export function rgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; // #fff is #ffffff
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Lattice points needed to hold `pitch` pixels between dots, at this view and canvas height.
 *
 * The depth that matters is the distance to the surface the camera looks at, which is the
 * distance to the center less the radius. Dividing by the distance to the center instead
 * understates how large a dot grows: the error is small when the camera is far, and it reaches
 * about 8x at the closest zoom, where a dot swells to 35 pixels.
 */
export function pixelsPerUnit(v: View, heightPx: number): number {
  const distance = Math.hypot(v.position[0], v.position[1], v.position[2]);
  const depth = Math.max(1e-3, distance - 1);
  return (v.focal * heightPx * 0.5) / depth;
}

export function dotsForPitch(v: View, heightPx: number, pitch: number): number {
  const px = pixelsPerUnit(v, heightPx);
  return (4 * Math.PI * px * px) / (pitch * pitch);
}

export interface SpherePass {
  /** Draws one frame. Returns false while the driver is still linking the shader. */
  draw(v: View, heightPx: number): boolean;
  setStyle(style: Partial<SphereStyle>): void;
  setLand(data: Uint8Array | null, width: number, height: number): void;
  setTint(data: Uint8Array | null, width: number, height: number): void;
  /** Where the sun is overhead. */
  setSun(lat: number, lng: number): void;
  /**
   * One value in 0..1 for each lattice dot, for `dots` dots. While set, the lattice holds that
   * count and ignores `dotPitch`, because the values are indexed by dot. Null clears it.
   */
  setDotData(values: Float32Array | null, dots: number): void;
  destroy(): void;
}

export function createSpherePass(gl: WebGL2RenderingContext, initial: Partial<SphereStyle> = {}): SpherePass {
  const style: SphereStyle = { ...DEFAULT_STYLE, ...initial };
  let sun: [number, number, number] = [0, 0, 1];
  let dataDots = 0; // the lattice count the per-dot data was built for, 0 for none
  let dataCols = 0;
  const prog = program(gl, VERT, FRAG);
  const vao = gl.createVertexArray()!; // WebGL2 needs a bound array object, even with no attribute

  const landFormat: TextureOptions = { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE };
  const tintFormat: TextureOptions = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  const dataFormat: TextureOptions = { internal: gl.R32F, format: gl.RED, type: gl.FLOAT };
  const land = texture(gl, landFormat);
  const tint = texture(gl, tintFormat);
  const data = texture(gl, dataFormat);
  const ramp = texture(gl, tintFormat);
  upload(gl, land, landFormat, new Uint8Array([0]), 1, 1);
  upload(gl, tint, tintFormat, new Uint8Array([0, 0, 0, 0]), 1, 1);

  // The ramp is a 256 texel row, built again only when dataColor changes.
  const setRamp = (stops: readonly string[]) => {
    const px = new Uint8Array(256 * 4);
    const colors = stops.map(rgb);
    for (let i = 0; i < 256; i++) {
      const f = (i / 255) * (colors.length - 1);
      const a = colors[Math.floor(f)], b = colors[Math.min(colors.length - 1, Math.floor(f) + 1)], t = f - Math.floor(f);
      for (let c = 0; c < 3; c++) px[i * 4 + c] = (a[c] + (b[c] - a[c]) * t) * 255;
      px[i * 4 + 3] = 255;
    }
    upload(gl, ramp, tintFormat, px, 256, 1);
  };
  if (Array.isArray(style.dataColor)) setRamp(style.dataColor);

  return {
    draw(v, heightPx) {
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

      /*
       * Grow the lattice as the camera moves in, so a dot keeps its size on screen. The lattice
       * is fixed in world space, thus without this a dot at the closest zoom covers 40 pixels and
       * the globe reads as a field of blobs. The count is quadratic in the zoom, which is why the
       * shader needed 32-bit index math: the old ceiling of 32768 dots is passed at a mild zoom.
       */
      const wanted = dataDots > 0 ? dataDots : style.dotPitch > 0 ? dotsForPitch(v, heightPx, style.dotPitch) : style.dots;
      const dots = Math.min(MAX_DOTS, Math.max(100, Math.round(wanted)));
      gl.uniform1f(u.uDots, dots);
      gl.uniform1f(u.uDotRadius, style.dotRatio * latticeSpacing(dots));
      gl.uniform1f(u.uDiffuse, style.diffuse);
      gl.uniform1f(u.uOceanDots, style.oceanDots);
      gl.uniform1f(u.uRim, style.rim);
      gl.uniform1f(u.uGlowWidth, style.glowWidth);
      gl.uniform3fv(u.uBase, rgb(style.base));
      gl.uniform3fv(u.uDot, rgb(style.dot));
      gl.uniform3fv(u.uGlow, rgb(style.glow));
      gl.uniform1f(u.uNight, style.night);
      gl.uniform3fv(u.uSun, sun);
      gl.uniform1f(u.uGraticule, style.graticule);
      gl.uniform1f(u.uGraticuleOpacity, style.graticuleOpacity);
      gl.uniform3fv(u.uGraticuleColor, rgb(style.graticuleColor));
      const useRamp = Array.isArray(style.dataColor);
      gl.uniform3fv(u.uDataColor, useRamp ? [0, 0, 0] : rgb(style.dataColor as string));
      gl.uniform1i(u.uUseRamp, useRamp && dataDots > 0 ? 1 : 0);
      gl.uniform1i(u.uDataCols, dataDots > 0 ? dataCols : 0);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, data);
      gl.uniform1i(u.uData, 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, ramp);
      gl.uniform1i(u.uRamp, 3);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, land);
      gl.uniform1i(u.uLand, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tint);
      gl.uniform1i(u.uTint, 1);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      return true;
    },
    setStyle(next) {
      Object.assign(style, next);
      if (Array.isArray(next.dataColor)) setRamp(next.dataColor);
    },
    setSun(lat, lng) { sun = unitVector(lat, lng); },
    setDotData(values, dots) {
      if (!values) { dataDots = 0; return; }
      // A texture wide enough that the tallest lattice still fits in the row limit.
      dataCols = 4096;
      const rows = Math.ceil((dots + 1) / dataCols);
      const padded = new Float32Array(dataCols * rows);
      padded.set(values.subarray(0, Math.min(values.length, padded.length)));
      upload(gl, data, dataFormat, padded, dataCols, rows);
      dataDots = dots;
    },
    setLand(data, width, height) {
      upload(gl, land, landFormat, data ?? new Uint8Array([0]), data ? width : 1, data ? height : 1);
    },
    setTint(data, width, height) {
      upload(gl, tint, tintFormat, data ?? new Uint8Array([0, 0, 0, 0]), data ? width : 1, data ? height : 1);
    },
    destroy() {
      prog.destroy();
      gl.deleteVertexArray(vao);
      gl.deleteTexture(land);
      gl.deleteTexture(tint);
      gl.deleteTexture(data);
      gl.deleteTexture(ramp);
    },
  };
}
