# globedots

A dot-matrix globe on WebGL2. 18.4 kB gzipped, no dependency, no three.js.

Markers, arcs, paths, bars, rings, labels, per-dot data, heat maps, borders, a day-night line,
click and hover events, and picking. The globe draws only when something changes.

## Quick start

```
npm install globedots
```

```html
<canvas id="globe" style="width: 600px; height: 600px"></canvas>
```

```js
import { createGlobe } from 'globedots';
import { land } from 'globedots/land';

const globe = createGlobe(document.getElementById('globe'), {
  camera: { lat: 20, lng: 0, altitude: 1.6 },
  autoRotate: 6, // degrees of longitude per second
});

globe.setLand(...await land()); // the 7 kB land mask that ships with the package
globe.setMarkers([{ lat: 51.5, lng: -0.13, size: 0.012, color: '#ff7a45', title: 'London' }]);
globe.setArcs([{ startLat: 51.5, startLng: -0.13, endLat: 35.7, endLng: 139.7 }]);
globe.on('click', (hit) => hit && globe.flyTo({ lat: hit.lat, lng: hit.lng, altitude: 0.6 }));

await globe.ready;
```

Drag to turn. Wheel or pinch to zoom. With the canvas focused, the arrow keys turn and
`+` and `-` zoom. Call `globe.destroy()` when the canvas leaves the page.

## Options

`createGlobe(canvas, options)`

| Option | Default | What it does |
|---|---|---|
| `camera` | `{ lat: 20, lng: 0, altitude: 1.6 }` | Where the camera starts. Altitude is in globe radii above the surface |
| `autoRotate` | `0` | Degrees of longitude per second |
| `style` | see Style | Colors and dot size |
| `interactive` | `true` | `false` turns the pointer and key handlers off |
| `minAltitude`, `maxAltitude` | `0.15`, `4` | Zoom limits |
| `devicePixelRatio` | device value, capped at 2 | Resolution of the canvas |

## Layers

Each setter replaces the whole layer. Pass `[]` to clear it. Colors are hex strings.

```js
globe.setMarkers([{ lat, lng, size: 0.01, altitude: 0, color, opacity: 1, shape: 'dot', title }], { transition: 0 });
// shape: 'dot' | 'ring' | 'square' | 'diamond'. size is in globe radii. With transition in
// milliseconds, each marker moves from the one at its index in the last set. A new marker grows
// in, and a removed one shrinks out.

globe.setArcs([{ startLat, startLng, endLat, endLng, stroke: 2, clearance, color, opacity: 1,
  dashLength: 1, dashGap: 0, dashSpeed: 0, appear: 0, vanish: 0, delay: 0, title }]);
// stroke is in pixels. clearance is the lift at the middle, in globe radii, and defaults to
// a value that grows with the distance. Dash lengths are fractions of the arc, dashSpeed is
// repeats per second. appear, vanish, and delay are milliseconds: the arc draws itself in
// from its start, then erases itself from its start.

globe.setPaths([{ points: [[lat, lng], ...], stroke: 2, altitude, color, opacity, appear, vanish, delay, title }]);
// A line that follows the surface. appear draws it in along its length.

globe.setBars([{ lat, lng, height, stroke: 4, color, opacity }]);
// height is in globe radii.

globe.setRings([{ lat, lng, maxRadius: 5, period: 3, width: 0.8, waves: 1, color, opacity: 1 }]);
// A pulse that grows to maxRadius degrees over period seconds. Rings keep the globe drawing.

globe.setLabels([{ lat, lng, text, element, altitude: 0, priority: 0, className }], { declutter: true });
// An HTML element that follows a place. It hides behind the globe, and yields to a label with
// a higher priority when the two overlap. Give element to use your own node.

globe.setDotData(values, dots);
// One value in 0..1 for each of `dots` lattice dots. A dot grows and takes the data color with
// its value. Build values with binPoints. Pass null to clear.

globe.setTint(rgba, width, height);
// An equirectangular RGBA raster. A dot takes the color under it, by the alpha. Build it with
// countryTint, heatmap, or imageTint. Pass null to clear.

globe.setLand(bytes, width, height);
// An equirectangular mask, 1 byte per cell, 255 for land. Build it with landMask, imageLand,
// or use land() from 'globedots/land'.

globe.setCountries(geometries);
// GeoJSON Polygon or MultiPolygon geometries, in order. pick() then names the country.

globe.setSun(new Date()); // or { lat, lng }. Set style.night above 0 to see the terminator.
```

## Camera

```js
globe.camera;                                   // { lat, lng, altitude }, read only
globe.setCamera({ lat, lng, altitude });        // any subset
await globe.flyTo({ lat, lng, altitude }, 1000); // eased. Resolves false when a drag cancels it
globe.setAutoRotate(6);
```

## Events and picking

```js
const off = globe.on('click', (hit) => { ... });
globe.on('rightclick', (hit) => { ... });
globe.on('hover', (hit) => { ... });   // null once when the pointer leaves the globe
globe.on('camera', (camera) => { ... });
globe.on('render', () => { ... });
globe.on('draw', (view) => { ... });   // draw your own WebGL layer with globe.gl and this view
off();
```

`hit` is `{ lat, lng, marker, arc, path, country, x, y, event }`. Each index is `-1` for none.
The same object comes from `globe.pick(x, y)` for a point in CSS pixels. `globe.project(lat,
lng, altitude)` gives `{ x, y, visible }` for a place. `globe.toBlob()` gives the frame as an
image.

A `title` on a marker, an arc, or a path shows as a tooltip on hover. Style `.globedots-tooltip`
to change its look.

## Style

`createGlobe(canvas, { style })` or `globe.setStyle({ ... })`.

| Key | Default | What it does |
|---|---|---|
| `dotPitch` | `7` | Distance between dots in CSS pixels. The lattice grows as you zoom in |
| `dots` | `24000` | Dot count when `dotPitch` is 0 |
| `dotRatio` | `0.27` | Dot radius as a fraction of the pitch |
| `diffuse` | `1.5` | How fast dots dim toward the limb |
| `oceanDots` | `0.07` | Brightness of the dots over water |
| `rim` | `0.3` | Edge highlight |
| `glowWidth` | `0.18` | Glow outside the disc, in globe radii |
| `night` | `0` | How dark the night side is, 0 to 1 |
| `graticule` | `0` | Degrees between grid lines. 0 draws none |
| `graticuleColor`, `graticuleOpacity` | `'#9aa3b0'`, `0.25` | |
| `dataColor` | `'#ff7a45'` | One color, or a list for a ramp from value 0 to 1 |
| `base`, `dot`, `glow` | `'#121316'`, `'#e6e6e6'`, `'#c9cfd8'` | Body, dot, and glow colors |

## Data helpers

All in the main package. They need no GPU.

```js
landMask(geometries, cols, rows)            // Uint8Array for setLand, from GeoJSON. Needs a 2D canvas
countryTint(entries, cols, rows)            // RGBA for setTint. entries: [{ geometry, color }]
heatmap(points, cols, rows, { radius, color }) // RGBA for setTint. points: [{ lat, lng, weight }]
imageLand(image, cols, rows, threshold)     // Uint8Array for setLand, bright pixels are land
imageTint(image, cols, rows)                // RGBA for setTint, from any equirectangular image
binPoints(points, dots)                     // Float32Array for setDotData, counts scaled to max 1
geometryPaths(geometry, { stroke, color })  // paths for setPaths, one per ring
countryIndex(geometries).locate(lat, lng)   // index of the polygon under a place, or -1
subsolarPoint(date)                         // { lat, lng } where the sun is overhead
haversineKm(a, b)                           // distance between two { lat, lng }
```

## Frameworks

React:

```jsx
import { useGlobe } from 'globedots/react';

function Globe({ markers }) {
  const { ref, globe } = useGlobe({ markers, autoRotate: 6, onClick: (hit) => console.log(hit) });
  return <canvas ref={ref} style={{ width: '100%', height: '100%' }} />;
}
```

The hook takes every `createGlobe` option, plus `markers`, `arcs`, `paths`, `bars`, `rings`,
`labels`, `onClick`, and `onHover`. `globe` is null until the canvas mounts.

Next.js: import the package as it is. No module touches `window` or `document` at import time,
so the server import works and the hook runs on the client. No dynamic import needed.

Vue, Svelte, and plain HTML: call `createGlobe` when the canvas mounts, and `destroy` when it
leaves.

## Size and speed

| | Raw | Gzipped |
|---|---|---|
| `react-globe.gl` with `three` | 1936 kB | 544.8 kB |
| `globedots` | 48.4 kB | 18.4 kB |

0.2 ms of CPU for a frame with 10 000 markers and 1000 arcs, 0 frames while idle. Measured
with `npm run bench`.

## Develop

```
npm install
npm run demo        # builds, then serves the demo on http://127.0.0.1:5173
npm test
npm run typecheck
npm run bench       # bundle size, then frame time in Chrome
```

## Acknowledgment

The rendering idea comes from [COBE](https://github.com/shuding/cobe) by Shu Ding: a full-screen
quad, a ray-cast sphere, and a Fibonacci lattice resolved in the fragment shader. globedots is a
rewrite, not a fork. The lattice inverse mapping is from Keinert et al., "Spherical Fibonacci
Mapping" (2015). Coastlines in the demo and in `globedots/land` are from Natural Earth.

## License

MIT
