/**
 * A land mask that ships with the package, for a globe with no data of its own.
 *
 * Natural Earth 110m countries, on a 1024 by 512 equirectangular grid, about 7 kB on the wire.
 * `scripts/bake-land.mjs` packs it: each row XORed with the row above, then bits, then gzip.
 * The browser unpacks it with DecompressionStream. For a sharper coast, build a larger mask
 * from your own polygons with `landMask`, or from an image with `imageLand`.
 */

import { DATA, WIDTH, HEIGHT } from './land.data';

/** The mask, ready to spread into `setLand`: `globe.setLand(...await land())`. */
export async function land(): Promise<[Uint8Array, number, number]> {
  const gz = Uint8Array.from(atob(DATA), (c) => c.charCodeAt(0));
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = Math.ceil(WIDTH / 8);
  const data = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const flip = (packed[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
      data[y * WIDTH + x] = y ? data[(y - 1) * WIDTH + x] ^ flip : flip;
    }
  }
  return [data, WIDTH, HEIGHT];
}
