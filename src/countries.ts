/**
 * Which country contains a place.
 *
 * This used to be a raster: paint each country in a color that encodes its index, then read the
 * index back. That cannot work. A canvas fill is antialiased, so a cell that a country covers in
 * part holds a blend of two colors, and a blended index decodes to a different country. Countries
 * sit at adjacent indices, thus the wrong answer is a real country and looks plausible. A small
 * island is worse: at 1024 by 512 it covers few cells, and every one of them is an edge.
 *
 * Point-in-polygon has none of those faults. It is exact at any size, and a bounding box rejects
 * nearly every country before the ray cast runs.
 */

import { unwrapRing, type AreaGeometry } from './landmask';

export interface CountryIndex {
  readonly length: number;
  /** Index of the country that contains the place, or -1. */
  locate(lat: number, lng: number): number;
}

interface Entry {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
  /** Rings of one polygon. Ring 0 is the outline, the rest are holes. */
  rings: number[][][];
}

/** Ray casting. `ring` is [lng, lat] pairs. */
function inRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inPolygon(lng: number, lat: number, poly: number[][][]): boolean {
  if (!poly.length || !inRing(lng, lat, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(lng, lat, poly[k])) return false; // a hole
  return true;
}

/**
 * Build the lookup. Rings are unwrapped first, so a country that crosses the antimeridian stays
 * one shape instead of a band across the map. A query is then tested at three longitudes, which
 * covers a shape that the unwrapping moved past 180 or below -180.
 */
export function countryIndex(geometries: readonly AreaGeometry[]): CountryIndex {
  const entries: Entry[][] = geometries.map((geometry) => {
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polys.map((poly) => {
      const rings = poly.map((ring) => unwrapRing(ring).pts as unknown as number[][]);
      let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const [lng, lat] of rings[0]) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      return { minLng, maxLng, minLat, maxLat, rings };
    });
  });

  return {
    length: geometries.length,
    locate(lat, lng) {
      for (let i = 0; i < entries.length; i++) {
        for (const part of entries[i]) {
          if (lat < part.minLat || lat > part.maxLat) continue;
          for (const shift of [0, 360, -360]) {
            const x = lng + shift;
            if (x < part.minLng || x > part.maxLng) continue;
            if (inPolygon(x, lat, part.rings)) return i;
          }
        }
      }
      return -1;
    },
  };
}
