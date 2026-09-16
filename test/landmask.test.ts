import { describe, expect, it } from 'vitest';
import { unwrapRing } from '../src/landmask';

describe('ring unwrapping', () => {
  it('keeps a ring that crosses the antimeridian continuous (Fiji)', () => {
    const fiji = [[178, -17], [179.5, -17], [-179.5, -17.5], [-179.8, -18], [178, -18], [178, -17]];
    const { pts, span } = unwrapRing(fiji);
    expect(pts.map((p) => p[0])).toEqual([178, 179.5, 180.5, 180.2, 178, 178]);
    expect(span).toBeCloseTo(2.5, 9);
  });

  it('leaves an ordinary ring unchanged', () => {
    const ring = [[-5, 40], [5, 40], [5, 50], [-5, 50], [-5, 40]];
    const { pts, span } = unwrapRing(ring);
    expect(pts).toEqual(ring);
    expect(span).toBe(10);
  });

  it('reports a full-width span for a ring that circles a pole', () => {
    const ring: number[][] = [];
    for (let lng = -180; lng <= 180; lng += 10) ring.push([lng, -70]);
    ring.push([180, -85], [-180, -85], [-180, -70]);
    expect(unwrapRing(ring).span).toBeGreaterThanOrEqual(360);
  });
});
