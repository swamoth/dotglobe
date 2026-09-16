/**
 * The orbit camera, and the two maps between the screen and the globe.
 *
 * The globe never moves. The camera orbits it, thus a point on the sphere is its own geographic
 * direction and needs no inverse rotation. `project` goes from a place to a pixel, for an HTML
 * overlay. `unproject` goes from a pixel to a place, for `pick`.
 *
 * Pure math. No GPU, no DOM.
 */

import type { Vec3 } from './fibonacci';
import { latLng, unitVector } from './fibonacci';

export interface Camera {
  lat: number;
  lng: number;
  /** Height of the camera above the surface, in globe radii. The sphere has radius 1. */
  altitude: number;
}

export interface View {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** 1 / tan(fov / 2). */
  focal: number;
  aspect: number;
}

/** The camera cannot reach a pole. The up vector is undefined there. */
export const MAX_LAT = 89.9;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Build the camera basis. `fov` is the vertical field of view in degrees. */
export function view(camera: Camera, aspect: number, fov = 45): View {
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, camera.lat));
  const d = 1 + Math.max(0.01, camera.altitude);
  const dir = unitVector(lat, camera.lng);
  const position: Vec3 = [dir[0] * d, dir[1] * d, dir[2] * d];
  const forward = norm([-dir[0], -dir[1], -dir[2]]);
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { position, forward, right, up, focal: 1 / Math.tan((fov * Math.PI) / 360), aspect };
}

/**
 * Distance along the ray to the near face of the unit sphere, or -1 for a miss. The ray
 * direction must be a unit vector.
 */
export function raySphere(origin: Vec3, dir: Vec3): number {
  const b = dot(origin, dir);
  const c = dot(origin, origin) - 1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

export interface Projected {
  /** Pixels from the left edge of the canvas. */
  x: number;
  /** Pixels from the top edge. */
  y: number;
  /** False when the globe hides the point, or when the point is behind the camera. */
  visible: boolean;
}

/**
 * Place a point on the screen. `altitude` lifts the point above the surface, in globe radii.
 *
 * The globe hides a point when the segment from the camera to the point crosses the sphere. That
 * test is exact for a marker on the surface and for a point above it, such as the middle of an
 * arc.
 */
export function project(v: View, lat: number, lng: number, altitude: number, width: number, height: number): Projected {
  const u = unitVector(lat, lng);
  const r = 1 + altitude;
  const p: Vec3 = [u[0] * r, u[1] * r, u[2] * r];
  const rel = sub(p, v.position);
  const z = dot(rel, v.forward);
  if (z <= 1e-6) return { x: NaN, y: NaN, visible: false }; // behind the camera

  const sx = (dot(rel, v.right) / z) * (v.focal / v.aspect);
  const sy = (dot(rel, v.up) / z) * v.focal;

  const len = Math.hypot(rel[0], rel[1], rel[2]);
  const t = raySphere(v.position, [rel[0] / len, rel[1] / len, rel[2] / len]);
  const occluded = t >= 0 && t < len - 1e-4;

  return {
    x: (sx * 0.5 + 0.5) * width,
    y: (1 - (sy * 0.5 + 0.5)) * height,
    visible: !occluded,
  };
}

/** The ray through a pixel. The direction is a unit vector. */
export function rayThrough(v: View, x: number, y: number, width: number, height: number): Vec3 {
  const u = (x / width) * 2 - 1;
  const w = 1 - (y / height) * 2;
  return norm([
    v.forward[0] + (v.right[0] * u * v.aspect + v.up[0] * w) / v.focal,
    v.forward[1] + (v.right[1] * u * v.aspect + v.up[1] * w) / v.focal,
    v.forward[2] + (v.right[2] * u * v.aspect + v.up[2] * w) / v.focal,
  ]);
}

/** The place under a pixel, or null when the pixel misses the globe. */
export function unproject(v: View, x: number, y: number, width: number, height: number): { lat: number; lng: number } | null {
  const dir = rayThrough(v, x, y, width, height);
  const t = raySphere(v.position, dir);
  if (t < 0) return null;
  const hit: Vec3 = [v.position[0] + dir[0] * t, v.position[1] + dir[1] * t, v.position[2] + dir[2] * t];
  return latLng(hit);
}
