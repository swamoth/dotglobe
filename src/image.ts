/**
 * Rasters from an equirectangular image, for a globe with no GeoJSON.
 *
 * Any image in the plate carree projection works: a black and white land map, a photo of the
 * earth, a night-lights map. The browser scales it to the raster size on a canvas, and the
 * bytes go to `setLand` or `setTint`. Load the image first, for example with
 * `createImageBitmap(await (await fetch(url)).blob())`.
 */

function pixels(image: CanvasImageSource, cols: number, rows: number): Uint8ClampedArray {
  const canvas = typeof OffscreenCanvas === 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(cols, rows);
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(image, 0, 0, cols, rows);
  return ctx.getImageData(0, 0, cols, rows).data;
}

/** The RGBA raster for `setTint`. A dot takes the color of the image under it. */
export function imageTint(image: CanvasImageSource, cols: number, rows: number): Uint8Array {
  return new Uint8Array(pixels(image, cols, rows).buffer);
}

/**
 * A land mask for `setLand`, from an image where land is bright and sea is dark. `threshold`
 * is the brightness in 0..1 that counts as land. Pass `invert` for a map with dark land.
 */
export function imageLand(image: CanvasImageSource, cols: number, rows: number, threshold = 0.5, invert = false): Uint8Array {
  const px = pixels(image, cols, rows);
  const out = new Uint8Array(cols * rows);
  const cut = threshold * 255 * 3;
  for (let i = 0; i < out.length; i++) {
    const bright = px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2];
    out[i] = (bright > cut) !== invert ? 255 : 0;
  }
  return out;
}
