import { describe, expect, it } from 'vitest';
import { countryIndex } from '../src/countries';
import type { AreaGeometry } from '../src/landmask';

/** A rectangle, counter-clockwise, as GeoJSON [lng, lat] pairs. */
const box = (w: number, s: number, e: number, n: number): AreaGeometry => ({
  type: 'Polygon',
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

describe('country lookup', () => {
  it('finds the country that contains a place, and none for the gap between', () => {
    const index = countryIndex([box(0, 0, 10, 10), box(20, 0, 30, 10)]);
    expect(index.locate(5, 5)).toBe(0);
    expect(index.locate(5, 25)).toBe(1);
    expect(index.locate(5, 15)).toBe(-1); // between the two
    expect(index.locate(50, 5)).toBe(-1); // north of both
  });

  it('respects a hole', () => {
    const withHole: AreaGeometry = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
      ],
    };
    const index = countryIndex([withHole]);
    expect(index.locate(2, 2)).toBe(0);
    expect(index.locate(5, 5)).toBe(-1); // inside the hole
    expect(index.locate(5, 8)).toBe(0);
  });

  it('handles a country that crosses the antimeridian', () => {
    // A box from 170 E to 170 W. In raw coordinates its longitudes jump by 340 degrees.
    const fiji = box(170, -20, -170, -10);
    const index = countryIndex([fiji]);
    expect(index.locate(-15, 175)).toBe(0);
    expect(index.locate(-15, -175)).toBe(0);
    expect(index.locate(-15, 179.9)).toBe(0);
    expect(index.locate(-15, 0)).toBe(-1); // the far side of the world, not inside
  });

  it('searches each part of a multi-polygon', () => {
    const twoIslands: AreaGeometry = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]],
        [[[40, 40], [45, 40], [45, 45], [40, 45], [40, 40]]],
      ],
    };
    const index = countryIndex([twoIslands]);
    expect(index.locate(2, 2)).toBe(0);
    expect(index.locate(42, 42)).toBe(0);
    expect(index.locate(20, 20)).toBe(-1);
  });

  it('returns -1 when nothing was indexed', () => {
    expect(countryIndex([]).locate(0, 0)).toBe(-1);
  });
});
