import { describe, expect, it } from 'vitest';
import {
  ARC_CLEARANCE_MAX, ARC_CLEARANCE_MIN, arcAltitudeFor, arcClearanceFor, arcHeight, centralAngle,
  haversineKm, interpolate, slerp, toRad, unitVector, wrapLng, type LatLng,
} from '../src/geo';
import { pathSegments } from '../src/arcs';

const NYC = { lat: 40.7128, lng: -74.006 };
const LONDON = { lat: 51.5074, lng: -0.1278 };
const SYDNEY = { lat: -33.8688, lng: 151.2093 };
const BRASILIA = { lat: -15.79, lng: -47.88 };
const HONG_KONG = { lat: 22.32, lng: 114.17 };

/**
 * Radial profile of an arc as globe.gl builds it (ArcsLayer.calcCurve): a cubic Bezier from a to
 * b, with control points at 25 % and 75 % of the great circle, 1.5 times the altitude out.
 * Returns heights above the surface at the interior samples.
 */
function bezierProfile(a: LatLng, b: LatLng, altitude: number, samples = 512) {
  const cart = (p: LatLng, alt = 0) => {
    const v = unitVector(p.lat, p.lng), r = 1 + alt;
    return [v[0] * r, v[1] * r, v[2] * r];
  };
  const P = [cart(a), cart(interpolate(a, b, 0.25), altitude * 1.5), cart(interpolate(a, b, 0.75), altitude * 1.5), cart(b)];
  const heights: number[] = [];
  for (let i = 1; i < samples; i++) {
    const t = i / samples, u = 1 - t;
    const w = [u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3];
    const v = [0, 1, 2].map((k) => w[0] * P[0][k] + w[1] * P[1][k] + w[2] * P[2][k] + w[3] * P[3][k]);
    heights.push(Math.hypot(v[0], v[1], v[2]) - 1);
  }
  return { min: Math.min(...heights), max: Math.max(...heights), mid: heights[samples / 2 - 1] };
}

describe('distance and interpolation', () => {
  it('matches known great-circle distances', () => {
    expect(haversineKm(NYC, LONDON)).toBeCloseTo(5570, -2); // within 50 km
    expect(haversineKm(LONDON, SYDNEY)).toBeCloseTo(16990, -2);
    expect(haversineKm(NYC, NYC)).toBe(0);
  });

  it('puts the midpoint of an interpolation on the great circle', () => {
    const mid = interpolate(NYC, LONDON, 0.5);
    expect(haversineKm(NYC, mid) + haversineKm(mid, LONDON)).toBeCloseTo(haversineKm(NYC, LONDON), 3);
  });

  it('keeps slerp on the unit sphere', () => {
    const a = unitVector(NYC.lat, NYC.lng), b = unitVector(SYDNEY.lat, SYDNEY.lng);
    for (const t of [0, 0.1, 0.5, 0.9, 1]) expect(Math.hypot(...slerp(a, b, t))).toBeCloseTo(1, 9);
    expect(slerp(a, b, 0)).toEqual(a);
  });

  it('wraps a longitude into [-180, 180)', () => {
    expect(wrapLng(190)).toBe(-170);
    expect(wrapLng(-190)).toBe(170);
    expect(wrapLng(180)).toBe(-180);
  });
});

describe('arc height', () => {
  it('grows the clearance with distance, between the bounds', () => {
    expect(arcClearanceFor(0)).toBe(ARC_CLEARANCE_MIN);
    expect(arcClearanceFor(Math.PI)).toBe(ARC_CLEARANCE_MAX);
    expect(arcClearanceFor(Math.PI / 2)).toBeCloseTo((ARC_CLEARANCE_MIN + ARC_CLEARANCE_MAX) / 2, 6);
    expect(arcClearanceFor(10)).toBe(ARC_CLEARANCE_MAX); // clamped
  });

  it('holds the dotglobe arc above the surface over its whole length', () => {
    for (const deg of [0.5, 5, 30, 90, 150, 179.5]) {
      const clearance = arcClearanceFor(toRad(deg));
      for (let i = 0; i <= 100; i++) expect(arcHeight(i / 100, clearance)).toBeGreaterThanOrEqual(0);
      expect(arcHeight(0, clearance)).toBe(0);
      expect(arcHeight(1, clearance)).toBeCloseTo(0, 12);
      expect(arcHeight(0.5, clearance)).toBeCloseTo(clearance, 12);
    }
  });

  it('lifts a globe.gl Bezier clear of the surface, short hop to antipodal', () => {
    for (const deg of [0.5, 5, 15, 30, 60, 90, 120, 150, 170, 179.5]) {
      const target = { lat: 0, lng: deg };
      const origin = { lat: 0, lng: 0 };
      const p = bezierProfile(origin, target, arcAltitudeFor(origin, target));
      expect(p.min, `${deg} degree arc dips into the globe`).toBeGreaterThan(0);
      expect(p.mid, `${deg} degree arc midpoint`).toBeCloseTo(arcClearanceFor(toRad(deg)), 3);
      expect(p.max, `${deg} degree arc leaves the atmosphere`).toBeLessThan(0.22);
    }
  });

  it('lifts a long haul more than a short hop on real routes', () => {
    const hop = arcAltitudeFor(NYC, LONDON);
    const haul = arcAltitudeFor(BRASILIA, HONG_KONG);
    expect(haul).toBeGreaterThan(hop * 3);
    for (const [a, b] of [[NYC, LONDON], [LONDON, SYDNEY], [BRASILIA, HONG_KONG]] as const) {
      const p = bezierProfile(a, b, arcAltitudeFor(a, b));
      expect(p.min).toBeGreaterThan(0);
      expect(p.mid).toBeCloseTo(arcClearanceFor(centralAngle(a, b)), 3);
    }
  });
});

describe('paths', () => {
  it('expands a path into one segment for each pair of points', () => {
    const segs = pathSegments([{ points: [[0, 0], [10, 10], [20, 20]], stroke: 3, color: '#fff' }]);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ startLat: 0, startLng: 0, endLat: 10, endLng: 10, stroke: 3 });
    expect(segs[1]).toMatchObject({ startLat: 10, startLng: 10, endLat: 20, endLng: 20 });
    // A path follows the surface, so its segments never bow away from it.
    for (const s of segs) expect(s.clearance).toBe(0);
  });

  it('draws nothing for a path with fewer than two points', () => {
    expect(pathSegments([{ points: [] }, { points: [[5, 5]] }])).toHaveLength(0);
  });

  it('keeps every path in one list', () => {
    const segs = pathSegments([
      { points: [[0, 0], [1, 1]] },
      { points: [[2, 2], [3, 3], [4, 4]] },
    ]);
    expect(segs).toHaveLength(3);
  });
});
