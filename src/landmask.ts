/**
 * Rasterize country polygons into the textures the globe samples.
 *
 * The projection is equirectangular: row 0 is lat 90, column 0 is lng -180. The sphere shader
 * samples the land mask to decide whether a dot is land, and the tint map to recolor a dot.
 * `pick()` samples the id raster to name the country under the cursor.
 *
 * This needs a 2D canvas, so it runs in a browser only. It returns null elsewhere.
 */

/** The part of GeoJSON this module reads. Declared here, so the package needs no type dependency. */
export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: number[][][];
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}
export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

/**
 * Make the longitudes of a ring continuous. When two points in sequence jump by more than 180
 * degrees, the ring crosses the antimeridian, as Fiji and eastern Russia do. Drawn as it is,
 * such a ring paints a band across the whole map. Returns the unwrapped points and the span.
 */
export function unwrapRing(ring: number[][]): { pts: [number, number][]; span: number } {
  const pts: [number, number][] = [];
  let offset = 0, prev = ring[0]?.[0] ?? 0, min = Infinity, max = -Infinity;
  for (const [lng, lat] of ring) {
    let l = lng + offset;
    if (l - prev > 180) { offset -= 360; l -= 360; } else if (l - prev < -180) { offset += 360; l += 360; }
    prev = l;
    pts.push([l, lat]);
    if (l < min) min = l;
    if (l > max) max = l;
  }
  return { pts, span: max - min };
}

/** Trace one geometry into the current path and fill it. */
function trace(ctx: CanvasRenderingContext2D, geometry: AreaGeometry, cols: number, rows: number) {
  const px = (lng: number) => ((lng + 180) / 360) * cols;
  const py = (lat: number) => ((90 - lat) / 180) * rows;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    ctx.beginPath();
    for (const ring of poly) {
      const { pts, span } = unwrapRing(ring);
      // A ring that circles a pole spans the full width and is correct as it is. Every other
      // ring is drawn unwrapped at three offsets. The canvas clips the copies that fall outside.
      const wrapsPole = span >= 360;
      const offsets = wrapsPole ? [0] : [-360, 0, 360];
      const source = wrapsPole ? (ring as [number, number][]) : pts;
      for (const off of offsets) {
        source.forEach(([lng, lat], i) => (i ? ctx.lineTo(px(lng + off), py(lat)) : ctx.moveTo(px(lng + off), py(lat))));
        ctx.closePath();
      }
      if (wrapsPole) {
        // The data stops short of the pole. Natural Earth ends Antarctica at -85.6 degrees. The
        // cap between that edge and the pole is the same land, thus fill it.
        let edge = 0;
        for (const [, lat] of ring) if (Math.abs(lat) > Math.abs(edge)) edge = lat;
        if (edge < 0) ctx.rect(0, py(edge), cols, rows - py(edge));
        else ctx.rect(0, 0, cols, py(edge));
      }
    }
    ctx.fill('evenodd');
  }
}

function context2d(cols: number, rows: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  return canvas.getContext('2d', { willReadFrequently: true });
}

/** Paint each entry in its own color, then read the pixels back. */
function paint(entries: { geometry: AreaGeometry; color: string }[], cols: number, rows: number): Uint8ClampedArray | null {
  const ctx = context2d(cols, rows);
  if (!ctx) return null;
  for (const e of entries) {
    ctx.fillStyle = e.color;
    trace(ctx, e.geometry, cols, rows);
  }
  return ctx.getImageData(0, 0, cols, rows).data;
}

/** One byte per cell, 255 for land. Feeds a single-channel texture. */
export function landMask(geometries: AreaGeometry[], cols: number, rows: number): Uint8Array | null {
  const rgba = paint(geometries.map((geometry) => ({ geometry, color: '#fff' })), cols, rows);
  if (!rgba) return null;
  const out = new Uint8Array(cols * rows);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3] > 96 ? 255 : 0;
  return out;
}

/** RGBA cells. Each entry is painted in its color, everything else stays transparent. */
export function countryTint(entries: { geometry: AreaGeometry; color: string }[], cols: number, rows: number): Uint8Array | null {
  const rgba = paint(entries, cols, rows);
  return rgba ? new Uint8Array(rgba.buffer.slice(0)) : null;
}

/**
 * One id per cell, for `pick()`. Index 0 means no country, so entry `i` is painted as `i + 1`.
 * The id is packed into red and green, which allows 65535 areas.
 */
export function countryIds(geometries: AreaGeometry[], cols: number, rows: number): Uint16Array | null {
  const entries = geometries.map((geometry, i) => {
    const id = i + 1;
    return { geometry, color: `rgb(${id & 255}, ${(id >> 8) & 255}, 0)` };
  });
  const rgba = paint(entries, cols, rows);
  if (!rgba) return null;
  const out = new Uint16Array(cols * rows);
  for (let i = 0; i < out.length; i++) {
    if (rgba[i * 4 + 3] < 96) continue;
    out[i] = rgba[i * 4] | (rgba[i * 4 + 1] << 8);
  }
  return out;
}

/** Sample a raster at a place. Longitudes outside [-180, 180) wrap. */
export function sampleAt<T extends { readonly length: number; [i: number]: number }>(
  raster: T, cols: number, rows: number, lat: number, lng: number,
): number {
  const x = Math.min(cols - 1, Math.max(0, Math.floor((((((lng + 180) % 360) + 360) % 360) / 360) * cols)));
  const y = Math.min(rows - 1, Math.max(0, Math.floor(((90 - lat) / 180) * rows)));
  return raster[y * cols + x];
}
