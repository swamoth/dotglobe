# dotglobe

A dot-matrix globe for the web. WebGL2, no three.js, no scene graph.

The globe is one full-screen quad. The fragment shader casts a ray at a sphere,
finds the nearest point of a spherical Fibonacci lattice, and asks a land mask
whether that point is land. Markers, arcs, and picking sit on top of that.

Status: v0.1 in progress. This README tracks what works today.

## Why

A dot globe needs a sphere, a lattice, and a land mask. It does not need a
scene graph, a mesh, or a 600 kB renderer. dotglobe ships the small part.

## Credit

The rendering idea comes from [COBE](https://github.com/shuding/cobe) by Shu Ding
(MIT): a full-screen quad, a ray-cast sphere, and a Fibonacci lattice resolved in
the fragment shader. dotglobe is a rewrite, not a fork. No COBE code is copied.

The lattice inverse mapping is from Keinert et al., "Spherical Fibonacci Mapping"
(2015), which COBE also uses.

## Targets

These are budgets, not measurements. The benchmark harness checks them.

| Budget | Target |
|---|---|
| Core bundle | under 20 kB gzipped |
| Frame time | under 4 ms at 2x DPR, mid phone |
| Idle CPU | 0 (render on demand) |
| First frame | under 50 ms |
| Markers | 10000 at 60 fps |
| Arcs | 1000 at 60 fps |

Run `npm run bench` to measure.

## Scope of v0.1

- Sphere pass with a land mask and a tint texture
- Markers from a data texture, no count cap
- Arcs as instanced ribbons with analytic sphere occlusion
- `project(lat, lng)` for HTML overlays
- `pick(x, y)` on the CPU: ray-sphere, nearest marker, country id
- Drag, inertia, zoom, auto-rotate
- Render on demand
- Vanilla core, plus a React hook at `dotglobe/react`

## License

MIT
