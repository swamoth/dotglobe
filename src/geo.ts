/**
 * Geographic math. Angles are degrees unless a name says radians.
 */

import type { Vec3 } from './fibonacci';
import { unitVector } from './fibonacci';

export interface LatLng {
  lat: number;
  lng: number;
}

export const EARTH_RADIUS_KM = 6371;

export const toRad = (d: number) => (d * Math.PI) / 180;
export const toDeg = (r: number) => (r * 180) / Math.PI;

/** Normalize a longitude to [-180, 180). */
export const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;

/** Great-circle distance in kilometers. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Angle between two places, in radians. */
export const centralAngle = (a: LatLng, b: LatLng) => haversineKm(a, b) / EARTH_RADIUS_KM;

/** Point at fraction `f` of the great circle from a to b. */
export function interpolate(a: LatLng, b: LatLng, f: number): LatLng {
  const p1 = toRad(a.lat), l1 = toRad(a.lng), p2 = toRad(b.lat), l2 = toRad(b.lng);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-9) return { lat: a.lat, lng: a.lng };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), lng: toDeg(Math.atan2(y, x)) };
}

/** Spherical linear interpolation between two unit vectors. */
export function slerp(a: Vec3, b: Vec3, f: number): Vec3 {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const d = Math.acos(dot);
  if (d < 1e-9) return [a[0], a[1], a[2]];
  const s = Math.sin(d);
  const A = Math.sin((1 - f) * d) / s;
  const B = Math.sin(f * d) / s;
  return [A * a[0] + B * b[0], A * a[1] + B * b[1], A * a[2] + B * b[2]];
}

export const ARC_CLEARANCE_MIN = 0.03;
export const ARC_CLEARANCE_MAX = 0.15;

/**
 * Height above the surface at the middle of an arc that spans `angle` radians, in globe radii.
 * A short hop stays low. A long haul rises, so it clears the bulge of the sphere between its
 * ends.
 */
export function arcClearanceFor(angle: number): number {
  const f = Math.min(1, Math.max(0, angle / Math.PI));
  return ARC_CLEARANCE_MIN + (ARC_CLEARANCE_MAX - ARC_CLEARANCE_MIN) * f;
}

/**
 * Height above the surface at fraction `t` of an arc, in globe radii.
 *
 * globedots builds an arc as a great circle that is lifted by this profile, so the arc is at
 * `clearance` at its middle and at 0 at both ends. A half sine never goes below 0, thus an arc
 * never cuts through the sphere. Compare `arcAltitudeFor`, which corrects a curve that can.
 */
export const arcHeight = (t: number, clearance: number) => clearance * Math.sin(Math.PI * t);

/**
 * Nominal altitude for a globe.gl arc between `a` and `b`, in globe radii.
 *
 * globe.gl draws an arc as a cubic Bezier. Its control points sit at 25 % and 75 % of the great
 * circle, 1.5 times the nominal altitude out. That curve is a chord, thus the middle of a long
 * arc sags toward the center of the globe. A fixed altitude lets a long arc cut the surface.
 * The library's auto-scale throws a medium arc far out. This function solves the Bezier midpoint
 * for the clearance that `arcClearanceFor` asks for.
 *
 * globedots does not need this for its own arcs. It is here for a caller that still draws with
 * globe.gl or three-globe, and for the NetEye migration.
 */
export function arcAltitudeFor(a: LatLng, b: LatLng): number {
  const theta = centralAngle(a, b);
  const clearance = arcClearanceFor(theta);
  // Bezier midpoint radius = (cos(theta/2) + 3 R cos(theta/4)) / 4, with R the control radius.
  const controlRadius = (4 * (1 + clearance) - Math.cos(theta / 2)) / (3 * Math.cos(theta / 4));
  return (controlRadius - 1) / 1.5;
}

/** Unit vector of a place. Re-exported so a caller needs one import for geometry. */
export { unitVector };

/**
 * The place where the sun is overhead at `date`, in degrees.
 *
 * A short form of the solar position: the declination from the day of the year, and the
 * longitude from the UTC time with the equation of time. It is within about 0.5 degrees of the
 * astronomical value, which a globe cannot show anyway.
 */
export function subsolarPoint(date: Date): LatLng {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = (date.getTime() - start) / 86400000; // days since Jan 1, with the fraction
  const b = (2 * Math.PI * (day - 81)) / 365.24;
  const declination = 23.44 * Math.sin(b);
  const equationOfTime = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b); // minutes
  const hours = (date.getTime() - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) / 3600000;
  return { lat: declination, lng: wrapLng(-15 * (hours - 12 + equationOfTime / 60)) };
}
