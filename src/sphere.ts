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
import { latticeSpacing } from './fibonacci';
import type { View } from './camera';

/**
 * Upper bound on the lattice.
 *
 * The 32-bit index math lifted the 2^15 ceiling of the WebGL1 method, but float32 sets a new one.
 * Measured on this shader: the lattice resolves cleanly to about 280000 points, thins at 300000,
 * and returns nothing at all past 330000, because a nearest point can no longer be told from its
 * neighbor. This value keeps a margin under that.
 */
export const MAX_DOTS = 262144;

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
    float g = uGlowWidth > 0.0 ? pow(max(0.0, 1.0 - miss / uGlowWidth), 4.0) : 0.0;
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

  /*
   * Shade the body linearly in nl. A curve such as pow(nl, 0.5) reaches full brightness a short
   * way in from the limb, which paints most of the disc one flat shade and leaves a dark band at
   * the edge. Linear limb darkening runs across the whole disc, so the sphere reads as round.
   */
  vec3 color = uBase * (0.25 + 0.75 * nl)
             + mix(uDot, tint.rgb, tint.a) * k
             // A thin edge highlight. A wide one reads as a ring sitting inside the silhouette.
             + pow(1.0 - nl, 10.0) * uGlow * uRim;
  fragColor = vec4(color, 1.0);
}`;

/** A hex color as three values in 0..1. Display values, with no color conversion. */
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
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
  destroy(): void;
}

export function createSpherePass(gl: WebGL2RenderingContext, initial: Partial<SphereStyle> = {}): SpherePass {
  const style: SphereStyle = { ...DEFAULT_STYLE, ...initial };
  const prog = program(gl, VERT, FRAG);
  const vao = gl.createVertexArray()!; // WebGL2 needs a bound array object, even with no attribute

  const landFormat: TextureOptions = { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE };
  const tintFormat: TextureOptions = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  const land = texture(gl, landFormat);
  const tint = texture(gl, tintFormat);
  upload(gl, land, landFormat, new Uint8Array([0]), 1, 1);
  upload(gl, tint, tintFormat, new Uint8Array([0, 0, 0, 0]), 1, 1);

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
      const wanted = style.dotPitch > 0 ? dotsForPitch(v, heightPx, style.dotPitch) : style.dots;
      const dots = Math.min(MAX_DOTS, Math.max(100, Math.round(wanted)));
      let radius = style.dotRatio * latticeSpacing(dots);
      if (style.dotPitch > 0) {
        /*
         * Past the lattice ceiling the camera keeps moving in and the spacing keeps growing, so a
         * dot would swell into a blob. Cap its diameter at the target pitch instead. The dots then
         * spread apart into a sparse grid, which still reads as a dot matrix.
         */
        const maxRadius = (style.dotPitch * 0.5) / pixelsPerUnit(v, heightPx);
        radius = Math.min(radius, maxRadius);
      }
      gl.uniform1f(u.uDots, dots);
      gl.uniform1f(u.uDotRadius, radius);
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
      return true;
    },
    setStyle(next) { Object.assign(style, next); },
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
    },
  };
}
