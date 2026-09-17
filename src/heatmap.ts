/**
 * A heat map, as the RGBA tint raster the sphere already samples.
 *
 * Each place adds a Gaussian bump to an equirectangular grid. The grid is scaled so the hottest
 * cell is 1, then written as one color with the heat in the alpha channel. `setTint` takes the
 * result, and a dot under a warm cell blends toward the color. For a discrete version on the
 * dots themselves, use `binPoints` and `setDotData` instead.
 */

import { rgb } from './sphere';

export interface HeatOptions {
  /** Radius of one bump, in degrees. The default is 4. */
  radius?: number;
  /** A hex color. The default is a warm orange. */
  color?: string;
}

export function heatmap(
  points: readonly { lat: number; lng: number; weight?: number }[],
  cols: number, rows: number, options: HeatOptions = {},
): Uint8Array {
  const radius = options.radius ?? 4;
  const rx = Math.max(1, (radius / 360) * cols);
  const ry = Math.max(1, (radius / 180) * rows);
  const reachX = Math.ceil(rx * 2.5), reachY = Math.ceil(ry * 2.5); // where a bump falls below 0.2 %
  const heat = new Float32Array(cols * rows);
  let max = 0;

  for (const p of points) {
    const w = p.weight ?? 1;
    const cx = ((((p.lng + 180) % 360) + 360) % 360 / 360) * cols;
    const cy = ((90 - p.lat) / 180) * rows;
    for (let dy = -reachY; dy <= reachY; dy++) {
      const y = Math.round(cy) + dy;
      if (y < 0 || y >= rows) continue;
      for (let dx = -reachX; dx <= reachX; dx++) {
        const x = (((Math.round(cx) + dx) % cols) + cols) % cols; // longitude wraps
        const fx = (x - cx + cols / 2 + cols) % cols - cols / 2; // shortest distance across the seam
        const fy = y - cy;
        const v = w * Math.exp(-2 * ((fx * fx) / (rx * rx) + (fy * fy) / (ry * ry)));
        const i = y * cols + x;
        heat[i] += v;
        if (heat[i] > max) max = heat[i];
      }
    }
  }

  const [r, g, b] = rgb(options.color ?? '#ff7a45');
  const out = new Uint8Array(cols * rows * 4);
  const scale = max > 0 ? 255 / max : 0;
  for (let i = 0; i < heat.length; i++) {
    out[i * 4] = r * 255;
    out[i * 4 + 1] = g * 255;
    out[i * 4 + 2] = b * 255;
    out[i * 4 + 3] = heat[i] * scale;
  }
  return out;
}
