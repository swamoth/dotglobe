# dotglobe

A dot-matrix globe for the web. WebGL2, no three.js, no scene graph.

The globe is one full-screen triangle. The fragment shader casts a ray at a sphere, finds the
nearest point of a spherical Fibonacci lattice, and asks a land mask whether that point is land.
Markers, arcs, and picking sit on top of that.

Status: v0.1 in progress. This README tracks what works today.

## Why

A dot globe needs a sphere, a lattice, and a land mask. It does not need a scene graph, a mesh,
or a 600 kB renderer. dotglobe ships the small part.

## Credit

The rendering idea comes from [COBE](https://github.com/shuding/cobe) by Shu Ding (MIT): a
full-screen quad, a ray-cast sphere, and a Fibonacci lattice resolved in the fragment shader.
dotglobe is a rewrite, not a fork. No COBE code is copied.

The lattice inverse mapping is from Keinert et al., "Spherical Fibonacci Mapping" (2015), which
COBE also uses.

## Use

```js
import { createGlobe } from 'dotglobe';
import { land } from 'dotglobe/land';

const globe = createGlobe(document.querySelector('canvas'), {
  camera: { lat: 20, lng: 0, altitude: 1.6 },
  autoRotate: 6, // degrees of longitude per second
});

globe.setLand(...await land()); // the mask that ships in 'dotglobe/land', or your own
globe.setMarkers([{ lat: 51.5, lng: -0.13, size: 0.012, color: '#ff5533' }]);
globe.setArcs([{ startLat: 51.5, startLng: -0.13, endLat: -33.9, endLng: 151.2 }]);

await globe.ready; // the first frame is on screen
```

Drag to turn. Use the wheel or a pinch to zoom. With the canvas focused, the arrow keys turn
and + and - zoom. `globe.flyTo({ lat, lng, altitude }, ms)` moves the camera with an ease. The globe draws one frame when something changes, then
stops. While nothing moves it schedules no frame and uses no CPU. Four things keep frames coming, and each
ends on its own: auto-rotation, inertia after a drag, a ring, and a dash that travels. Measured:
61 frames a second with a dashed arc on screen, and 0 with the same arc solid.

`dotglobe/land` is a 7 kB mask of Natural Earth 110m coastlines, for a globe with no data of
its own. For a sharper coast, build one from country polygons with `landMask`, from an image
with `imageLand`, or upload a raster of your own: 1 byte per cell, 255 for land.

An arc can draw itself in and erase itself: `{ ..., appear: 900, vanish: 900 }`, in
milliseconds, plus `delay`. A path does the same along its length. The globe keeps drawing
until the last one settles, then stops.

### Events, labels, and picking

```js
globe.on('click', (hit) => hit && globe.flyTo({ lat: hit.lat, lng: hit.lng, altitude: 0.6 }));
globe.on('hover', (hit) => tooltip.textContent = hit ? names[hit.country] : '');
globe.setLabels([{ lat: 51.5, lng: -0.13, text: 'London', priority: 2 }]);

const at = globe.project(51.5, -0.13);   // CSS pixels, plus visible: false behind the globe
const hit = globe.pick(x, y);            // { lat, lng, marker, country, arc, path } or null
```

A marker, an arc, or a path with a `title` shows it as a tooltip on hover. Style the
`.dotglobe-tooltip` class to change its look.

Events: `click`, `rightclick`, `hover`, `camera`, `render`, and `draw`, which hands you
the view so you can draw your own WebGL layer with `globe.gl`. A label is an HTML element in a
layer over the canvas. The globe hides a label behind the globe, and hides one that would
overlap a label with a higher priority. `project` and the shaders run the same ray-sphere
occlusion test, so an overlay hides exactly when its pixel does.

`globe.toBlob()` gives the frame as an image. When the browser drops the WebGL context, the
globe builds itself again from the data you gave it. When the canvas scrolls out of view, the
globe stops drawing until it is back.

### A globe from an image

```js
const img = await createImageBitmap(await (await fetch('earth.png')).blob());
globe.setLand(imageLand(img, 2048, 1024), 2048, 1024); // bright pixels are land
globe.setTint(imageTint(img, 2048, 1024), 2048, 1024); // or: each dot takes the color under it
```

### React

```jsx
import { useGlobe } from 'dotglobe/react';

function Globe({ markers }) {
  const { ref, globe } = useGlobe({ markers, autoRotate: 6 });
  return <canvas ref={ref} style={{ width: '100%', height: '100%' }} />;
}
```

## Measurements

Run `npm run bench`. Numbers below are from one desktop with an 800 by 800 canvas at 2x DPR,
with the CPU throttled 4x to stand in for a mid phone.

| Budget | Target | Measured |
|---|---|---|
| Core bundle, gzipped | under 20 kB | 17.8 kB |
| Frame, CPU | under 4 ms | 0.20 ms |
| Frame, GPU | — | 1.7 to 2.2 ms |
| Main thread blocked at start | under 20 ms | 14 to 16 ms |
| Idle frames per second | 0 | 0 |
| 10000 markers | 60 fps | no measurable GPU cost |
| 1000 arcs | 60 fps | about 0.5 ms of GPU added |

The React entry is a separate 0.44 kB module that imports the core, so a caller who does not use
React pays nothing.

### Dot density follows the zoom

The lattice is fixed in world space, so a dot grows on screen as the camera moves in. Left
alone it reaches 31 pixels at the closest zoom and the globe reads as a field of blobs.

`dotPitch` sets the distance between two dots in CSS pixels, and the lattice grows with the
zoom to hold it. A coastline gains detail as you move in, rather than losing it. Set `dotPitch`
to 0 to fix the lattice at `dots` instead.

The lattice resolves exactly to 8 million points on the GPU. Every place the shader needs the
fractional part of a large product, it uses exact 32-bit integer math instead of float32. That
holds a 7 pixel pitch at every zoom the camera allows.

### Against the stack it replaces

Both sides bundled with the same esbuild settings and the same gzip, with React external on
each. Measured from a NetEye checkout that has the old stack installed.

| Import | Raw | Gzipped |
|---|---|---|
| `react-globe.gl` | 1936 kB | 544.81 kB |
| `globe.gl` | 1919 kB | 541.98 kB |
| `three-globe` | 1607 kB | 455.53 kB |
| `three` | 725 kB | 185.86 kB |
| **dotglobe** | **47.1 kB** | **17.8 kB** |

react-globe.gl is 56.6 times the gzipped size of dotglobe. Each row is the whole library as an
app imports it. globe.gl and three-globe build on kapsule and are not written to tree-shake, so
an app takes close to all of it. Run `npm run bench:compare -- <path-to-app>` to repeat this.

### A note on the first frame

The original target was a first frame under 50 ms. Measurement showed that the budget does not
describe anything this library controls:

- The first WebGL2 context on a page costs 80 to 160 ms in Chrome. That is the handshake with the
  GPU process, and every WebGL page pays it once.
- The first compile of the sphere shader costs about 56 ms. The same compile costs 6 ms the
  second time, because ANGLE caches its translation for the life of the process.
- Uploading a 2 MB land mask costs 3 ms, so a prebaked PNG was never the thing to fix.

dotglobe therefore does not block the main thread on any of it. It links a program without
reading the link status, asks `KHR_parallel_shader_compile` for each frame, and draws each pass
as soon as that pass is ready. The sphere never waits for the marker or arc shader. Main thread
blocked went from 55 ms to about 14 ms.

The benchmark gates blocked time, which is stable and is what a visitor feels as a freeze. It
reports first-frame wall clock, but gates it only loosely, because the graphics driver keeps a
cache that the harness cannot clear.

## Scope of v0.1

- [x] Sphere pass with a land mask and a tint texture
- [x] Markers from a data texture, no count cap
- [x] Arcs as instanced ribbons with analytic sphere occlusion
- [x] `project(lat, lng)` for HTML overlays
- [x] `pick(x, y)` on the CPU: ray-sphere, nearest marker, country id
- [x] Drag, inertia, zoom, auto-rotate
- [x] Render on demand
- [x] Rings that pulse outward from a place
- [x] Paths that follow the surface, for a cable or a route
- [x] Dashed arcs, with a pattern that can travel
- [x] `flyTo` with an ease in and out, pinch zoom, and keyboard control
- [x] `prefers-reduced-motion`: nothing moves on its own when the OS asks
- [x] A day and night terminator, with the sun placed by a date
- [x] Graticules
- [x] Per-dot data: a value for each lattice dot sets its size and color. `binPoints` builds it from places, which is the hex-bin of a dot globe
- [x] Bars that rise from a place
- [x] Marker shapes: dot, ring, square, diamond
- [x] Borders: `geometryPaths` turns any GeoJSON area into paths
- [x] Heat map: `heatmap` builds a tint raster from weighted places
- [x] Events: click, right click, hover, camera, and a draw hook for a custom WebGL layer
- [x] Arcs and paths that draw themselves in and erase themselves, for an emit-on-click effect
- [x] `pick` finds the arc or the path under a point, for a highlight on hover. 1000 arcs: under 1 ms
- [x] A color ramp for per-dot data: `dataColor: ['#3b4261', '#7aa2f7', '#ff7a45']`
- [x] `dotglobe/land`: a 7 kB land mask that ships with the package
- [x] HTML labels with occlusion and declutter, and a tooltip from a `title`
- [x] `toBlob` screenshot, WebGL context loss recovery, no drawing while out of view
- [x] `imageLand` and `imageTint`: a land mask or a color for each dot from any equirectangular image
- [x] Vanilla core, plus a React hook at `dotglobe/react`
- [x] A demo page with real coastlines

## See it running

```
npm install
npm run demo      # builds, then serves the demo on http://127.0.0.1:5173
```

The demo is a story. The globe stays pinned while the page scrolls, and each chapter sets its
layers and moves the camera: 10 000 markers, arcs that draw themselves in, data on the dots, a
heat map with borders, labels, and the day-night line. Real coastlines from Natural Earth. Drag
to turn, scroll on the globe to zoom, click to send an arc.

The Debug link in the navigation opens a panel that binds every style value, the camera, and
each layer to a plain form control, and shows the frame rate, the lattice in use, and the
camera. `window.globe` is exposed too, so `globe.pick` and `globe.project` can be tried
from the console.

## Develop

```
npm install
npm test          # unit tests for the math that needs no GPU
npm run typecheck
npm run bench     # bundle size, then frame time in Chrome
```

`npm run bench:size -- --why` prints the per-module size breakdown.

## License

MIT
