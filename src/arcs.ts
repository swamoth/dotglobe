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
import { unitVector } from './fibonacci';
import { rgb } from './sphere';
import { unwrapRing, type AreaGeometry } from './landmask';

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
  /**
   * Height above the surface along the whole arc, in globe radii. The default is 0.002, which
   * lifts the ribbon clear of the surface so the occlusion test cannot drop it against itself.
   */
  altitude?: number;
  /** Height at the far end, in globe radii. Defaults to `altitude`. A bar sets this higher. */
  endAltitude?: number;
  /**
   * Length of one dash, as a fraction of the arc. The default is 1, which draws a solid line.
   * A dash and a gap together make the repeat, so 0.1 and 0.1 gives ten dashes over the arc.
   */
  dashLength?: number;
  /** Length of the gap after a dash, as a fraction of the arc. The default is 0. */
  dashGap?: number;
  /** Repeats the dash pattern travels each second. 0 holds it still. The default is 0. */
  dashSpeed?: number;
  /** A hex color. The default is white. */
  color?: string;
  /** Opacity in 0..1. The default is 1. */
  opacity?: number;
  /** Milliseconds to draw the arc in from its start, once it is set. The default is 0: at once. */
  appear?: number;
  /** Milliseconds to erase the arc from its start, after it has appeared. The default is 0: never. */
  vanish?: number;
  /** Milliseconds to wait before the arc appears. The default is 0. */
  delay?: number;
  /** Milliseconds to wait after the appear before the vanish starts. The default is 0. */
  vanishDelay?: number;
}

/** Texels across each data texture. */
const COLS = 1024;
/** Steps along one arc. A ribbon of 48 steps has no visible corner at any zoom this globe allows. */
const SEGMENTS = 48;

export interface ArcPassOptions {
  /** Steps along one arc. A path segment is short and straight, so it needs far fewer. */
  segments?: number;
}

const VERT = `#version 300 es
precision highp float;

uniform vec3 uCamPos, uForward, uRight, uUp;
uniform float uFocal, uAspect;
uniform vec2 uViewport;
uniform sampler2D uEnds;
uniform sampler2D uStyle;
uniform sampler2D uColor;
uniform sampler2D uDash;
uniform sampler2D uAnim;
uniform int uCols, uSegments;
uniform float uTime;

out vec4 vColor;
out vec3 vWorld;
out float vT;
out vec3 vDash; // dash length, repeat length, travel
out vec2 vClip; // the drawn part of the arc: from the tail to the head, as fractions

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
  vec4 dash = texelFetch(uDash, at, 0);
  vDash = vec3(dash.x, max(dash.x + dash.y, 1e-6), dash.z);

  // Appear and vanish. anim holds the start, the appear time, the vanish start, and the vanish
  // time, in seconds of the globe clock. An arc with no animation is drawn whole.
  vec4 anim = texelFetch(uAnim, at, 0);
  float head = anim.y > 0.0 ? clamp((uTime - anim.x) / anim.y, 0.0, 1.0) : 1.0;
  float tail = anim.w > 0.0 ? clamp((uTime - anim.z) / anim.w, 0.0, 1.0) : 0.0;
  vClip = vec2(tail * tail, 1.0 - (1.0 - head) * (1.0 - head)); // ease in, and ease out

  int seg = gl_VertexID >> 1;
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  float steps = float(uSegments);
  float t = float(seg) / steps;
  vT = t;

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
  vec3 w1 = p1 * (1.0 + mix(style.z, style.w, t) + style.x * sin(PI * t));
  vec3 w2 = p2 * (1.0 + mix(style.z, style.w, t2) + style.x * sin(PI * t2));
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
uniform float uTime;
in vec4 vColor;
in vec3 vWorld;
in float vT;
in vec3 vDash;
in vec2 vClip;
out vec4 fragColor;

void main() {
  if (vT < vClip.x || vT > vClip.y) discard;
  /*
   * Dashes. vDash holds the dash length, the repeat length, and how many repeats travel each
   * second. A solid arc has a dash as long as the repeat, so this never drops a fragment.
   */
  if (vDash.x < vDash.y) {
    float along = fract(vT / vDash.y - uTime * vDash.z);
    if (along * vDash.y > vDash.x) discard;
  }

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
  draw(v: View, viewport: [number, number], seconds: number): boolean;
  /** `now` is the globe clock in seconds, for an arc that appears. Null draws every arc whole. */
  set(arcs: readonly Arc[], now?: number | null): void;
  readonly count: number;
  /** True when any arc has a dash pattern that travels, so the globe must keep drawing. */
  readonly animated: boolean;
  /** Globe clock in seconds when the last arc finishes its appear or vanish. -Infinity for none. */
  readonly until: number;
  destroy(): void;
}

export function createArcPass(gl: WebGL2RenderingContext, options: ArcPassOptions = {}): ArcPass {
  const segments = Math.max(1, Math.round(options.segments ?? SEGMENTS));
  const prog: Program = program(gl, VERT, FRAG);
  const vao = gl.createVertexArray()!;

  const floatFormat: TextureOptions = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
  const colorFormat: TextureOptions = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  const ends = texture(gl, floatFormat);
  const style = texture(gl, floatFormat);
  const dash = texture(gl, floatFormat);
  const anim = texture(gl, floatFormat);
  const color = texture(gl, colorFormat);

  let count = 0;
  let animated = false;
  let until = -Infinity;
  upload(gl, ends, floatFormat, new Float32Array(4), 1, 1);
  upload(gl, style, floatFormat, new Float32Array(4), 1, 1);
  upload(gl, dash, floatFormat, new Float32Array([1, 0, 0, 0]), 1, 1);
  upload(gl, anim, floatFormat, new Float32Array(4), 1, 1);
  upload(gl, color, colorFormat, new Uint8Array(4), 1, 1);

  return {
    get count() { return count; },
    get animated() { return animated; },
    get until() { return until; },
    draw(v, viewport, seconds) {
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
      gl.uniform1i(u.uSegments, segments);
      gl.uniform1f(u.uTime, seconds);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ends);
      gl.uniform1i(u.uEnds, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, style);
      gl.uniform1i(u.uStyle, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, color);
      gl.uniform1i(u.uColor, 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, dash);
      gl.uniform1i(u.uDash, 3);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, anim);
      gl.uniform1i(u.uAnim, 4);

      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (segments + 1) * 2, count);
      gl.bindVertexArray(null);
      return true;
    },
    set(arcs, now = null) {
      count = arcs.length;
      animated = false; // before the early return, or a removed dash keeps the loop awake
      until = -Infinity;
      if (count === 0) return;
      const rows = Math.ceil(count / COLS);
      const cells = COLS * rows;
      const e = new Float32Array(cells * 4);
      const s = new Float32Array(cells * 4);
      const dashData = new Float32Array(cells * 4);
      const animData = new Float32Array(cells * 4);
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
        s[i * 4 + 2] = arc.altitude ?? 0.002;
        s[i * 4 + 3] = arc.endAltitude ?? arc.altitude ?? 0.002;
        dashData[i * 4] = arc.dashLength ?? 1;
        dashData[i * 4 + 1] = arc.dashGap ?? 0;
        dashData[i * 4 + 2] = arc.dashSpeed ?? 0;
        if ((arc.dashSpeed ?? 0) !== 0 && (arc.dashGap ?? 0) > 0) animated = true;
        if (now !== null && (arc.appear || arc.vanish)) {
          const start = now + (arc.delay ?? 0) / 1000;
          const appear = (arc.appear ?? 0) / 1000;
          const vanishStart = start + appear + (arc.vanishDelay ?? 0) / 1000;
          const vanish = (arc.vanish ?? 0) / 1000;
          animData[i * 4] = start;
          animData[i * 4 + 1] = appear;
          animData[i * 4 + 2] = vanishStart;
          animData[i * 4 + 3] = vanish;
          until = Math.max(until, vanish > 0 ? vanishStart + vanish : start + appear);
        }
        const [r, g, b] = arc.color ? rgb(arc.color) : [1, 1, 1];
        c[i * 4] = r * 255;
        c[i * 4 + 1] = g * 255;
        c[i * 4 + 2] = b * 255;
        c[i * 4 + 3] = (arc.opacity ?? 1) * 255;
      }
      upload(gl, ends, floatFormat, e, COLS, rows);
      upload(gl, style, floatFormat, s, COLS, rows);
      upload(gl, dash, floatFormat, dashData, COLS, rows);
      upload(gl, anim, floatFormat, animData, COLS, rows);
      upload(gl, color, colorFormat, c, COLS, rows);
    },
    destroy() {
      prog.destroy();
      gl.deleteVertexArray(vao);
      gl.deleteTexture(ends);
      gl.deleteTexture(style);
      gl.deleteTexture(dash);
      gl.deleteTexture(anim);
      gl.deleteTexture(color);
    },
  };
}

export interface Path {
  /** The line, as [lat, lng] pairs. Fewer than two points draws nothing. */
  points: readonly (readonly [number, number])[];
  /** Width in pixels. The default is 2. */
  stroke?: number;
  /** Height above the surface, in globe radii. The default is 0.002. */
  altitude?: number;
  /** A hex color. The default is white. */
  color?: string;
  /** Opacity in 0..1. The default is 1. */
  opacity?: number;
  /** Milliseconds to draw the path in from its first point. The default is 0: at once. */
  appear?: number;
  /** Milliseconds to erase the path from its first point, after it has appeared. */
  vanish?: number;
  /** Milliseconds to wait before the path appears. */
  delay?: number;
}

/**
 * Expand paths into the arc segments that draw them.
 *
 * A path is a line that follows the surface, and an arc with no clearance is exactly that between
 * two points. One segment for each pair therefore needs no second kind of pass, and the segments
 * of every path go into one instanced draw call.
 */
export function pathSegments(paths: readonly Path[]): Arc[] {
  const out: Arc[] = [];
  for (const path of paths) {
    const n = path.points.length - 1;
    // Each segment takes its share of the appear time, one after the other, so the whole path
    // draws in from the first point at one speed. The vanish runs the same way.
    const appear = (path.appear ?? 0) / n, vanish = (path.vanish ?? 0) / n;
    for (let i = 1; i <= n; i++) {
      const a = path.points[i - 1];
      const b = path.points[i];
      out.push({
        startLat: a[0], startLng: a[1], endLat: b[0], endLng: b[1],
        clearance: 0,
        stroke: path.stroke,
        altitude: path.altitude,
        color: path.color,
        opacity: path.opacity,
        appear, vanish,
        delay: (path.delay ?? 0) + appear * (i - 1),
        vanishDelay: appear * (n - i) + vanish * (i - 1),
      });
    }
  }
  return out;
}

export interface Bar {
  lat: number;
  lng: number;
  /** Height above the surface, in globe radii. */
  height: number;
  /** Width in pixels. The default is 4. */
  stroke?: number;
  color?: string;
  opacity?: number;
}

/** A bar is an arc from a place at the surface to the same place at its height. */
export function barArcs(bars: readonly Bar[]): Arc[] {
  return bars.map((b) => ({
    startLat: b.lat, startLng: b.lng, endLat: b.lat, endLng: b.lng,
    clearance: 0, altitude: 0.002, endAltitude: b.height,
    stroke: b.stroke ?? 4, color: b.color, opacity: b.opacity,
  }));
}

/**
 * The outline of a country or any area, as paths. One path for each ring. A ring is unwrapped
 * first, so a border that crosses the antimeridian stays one line.
 */
export function geometryPaths(geometry: AreaGeometry, style: Omit<Path, 'points'> = {}): Path[] {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const out: Path[] = [];
  for (const poly of polys) {
    for (const ring of poly) {
      out.push({ ...style, points: unwrapRing(ring).pts.map(([lng, lat]) => [lat, lng] as const) });
    }
  }
  return out;
}

/**
 * The arc under a pixel, or -1. Each arc is sampled along its length with the same curve the
 * shader draws, projected, and tested against the pixel as a chain of segments. An arc counts
 * as hit within half its stroke plus a 4 pixel margin, and the nearest one wins.
 *
 * ponytail: every arc is sampled on every call, which is about 3 ms for 1000 arcs. A screen
 * space index if a page picks that many on every pointer move.
 */
export function pickArc(arcs: readonly Arc[], v: View, x: number, y: number, width: number, height: number): number {
  const STEPS = 24;
  const [cx, cy, cz] = v.position;
  const cc = cx * cx + cy * cy + cz * cz - 1;
  let best = -1, bestDist = Infinity;
  let px = 0, py = 0, pv = false;
  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i];
    const a = unitVector(arc.startLat, arc.startLng);
    const b = unitVector(arc.endLat, arc.endLng);
    const omega = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    const sinOmega = Math.sin(omega);
    const clearance = arc.clearance ?? arcClearanceFor(omega);
    const alt = arc.altitude ?? 0.002, endAlt = arc.endAltitude ?? alt;
    const reach = (arc.stroke ?? 2) / 2 + 4;
    for (let s = 0; s <= STEPS; s++) {
      const t = s / STEPS;
      const wa = sinOmega < 1e-6 ? 1 - t : Math.sin((1 - t) * omega) / sinOmega;
      const wb = sinOmega < 1e-6 ? t : Math.sin(t * omega) / sinOmega;
      const r = 1 + alt + (endAlt - alt) * t + clearance * Math.sin(Math.PI * t);
      const wx = (wa * a[0] + wb * b[0]) * r, wy = (wa * a[1] + wb * b[1]) * r, wz = (wa * a[2] + wb * b[2]) * r;
      // Project, with the same occlusion test as the shader.
      const rx = wx - cx, ry = wy - cy, rz = wz - cz;
      const z = rx * v.forward[0] + ry * v.forward[1] + rz * v.forward[2];
      const len = Math.hypot(rx, ry, rz);
      const bb = (cx * rx + cy * ry + cz * rz) / len;
      const disc = bb * bb - cc;
      const visible = z > 1e-6 && !(disc > 0 && -bb - Math.sqrt(disc) > 0 && -bb - Math.sqrt(disc) < len - 1e-4);
      const sx = (((rx * v.right[0] + ry * v.right[1] + rz * v.right[2]) / z) * (v.focal / v.aspect) * 0.5 + 0.5) * width;
      const sy = (1 - (((rx * v.up[0] + ry * v.up[1] + rz * v.up[2]) / z) * v.focal * 0.5 + 0.5)) * height;
      if (s > 0 && visible && pv) {
        // Distance from the pixel to the segment from the last sample to this one.
        const dx = sx - px, dy = sy - py;
        const l2 = dx * dx + dy * dy;
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / l2)) : 0;
        const d = Math.hypot(x - (px + u * dx), y - (py + u * dy));
        if (d < reach && d < bestDist) { bestDist = d; best = i; }
      }
      px = sx; py = sy; pv = visible;
    }
  }
  return best;
}
