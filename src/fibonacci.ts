/**
 * Spherical Fibonacci lattice: `n` points spread almost evenly over the unit sphere, plus the
 * O(1) inverse lookup that finds the nearest lattice point to any direction.
 *
 * This is the CPU twin of the GLSL in the sphere shader. The shader draws the dots. This copy
 * exists so the math can be unit-tested, and so `pick()` can name the dot under the cursor.
 *
 * Axis convention: y is up, the prime meridian faces +z. The lattice puts its polar axis on y,
 * so the spiral seam of the lattice sits at the geographic poles.
 *
 * Inverse mapping after Keinert et al., "Spherical Fibonacci Mapping" (2015). COBE
 * (github.com/shuding/cobe, MIT) uses the same mapping.
 */

export type Vec3 = [number, number, number];

const SQRT5 = Math.sqrt(5);
const PHI = (1 + SQRT5) / 2;
const TAU = Math.PI * 2;

/** Lattice point `i` of `n`. */
export function latticePoint(i: number, n: number): Vec3 {
  const z = 1 - (2 * i) / n;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const theta = TAU * ((i * (PHI - 1)) % 1);
  return [Math.cos(theta) * r, z, Math.sin(theta) * r];
}

/** Brute-force nearest lattice point. Reference for the tests, too slow for real use. */
export function nearestBruteForce(p: Vec3, n: number): { index: number; point: Vec3; dist: number } {
  let best = { index: -1, point: [0, 0, 0] as Vec3, dist: Infinity };
  for (let i = 0; i <= n; i++) {
    const q = latticePoint(i, n);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < best.dist) best = { index: i, point: q, dist: d };
  }
  return best;
}

/**
 * Nearest lattice point to unit vector `p` among `n` points, in O(1). The shader mirrors this
 * line for line. The shader needs a binary ladder to keep precision on large indices. This
 * double-precision version takes the fractional part directly.
 */
export function nearestLattice(p: Vec3, n: number): { index: number; point: Vec3; dist: number } {
  // Internal frame: polar axis on z.
  const px = p[0], py = p[2], pz = p[1];
  const k = Math.max(2, Math.floor(Math.log2(SQRT5 * n * Math.PI * (1 - pz * pz)) * 0.72021));
  const fk = Math.pow(PHI, k) / SQRT5;
  const f0 = Math.floor(fk + 0.5);
  const f1 = Math.floor(fk * PHI + 0.5);
  const br1x = (((f0 + 1) * (PHI - 1)) % 1) * TAU - 3.883222;
  const br1y = (((f1 + 1) * (PHI - 1)) % 1) * TAU - 3.883222;
  const br2x = -2 * f0;
  const br2y = -2 * f1;
  const spx = Math.atan2(py, px);
  const spy = pz - 1;
  const det = br1x * br2y - br2x * br1y;
  const cx = Math.floor((br2y * spx - br1y * (spy * n + 1)) / det);
  const cy = Math.floor((-br2x * spx + br1x * (spy * n + 1)) / det);

  let best = { index: -1, point: [0, 0, 0] as Vec3, dist: Math.PI };
  for (let s = 0; s < 4; s++) {
    const ox = s % 2, oy = Math.floor(s / 2);
    const idx = f0 * (cx + ox) + f1 * (cy + oy);
    if (idx > n || idx < 0) continue;
    const q = latticePoint(idx, n);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < best.dist) best = { index: idx, point: q, dist: d };
  }
  return best;
}

/** Mean spacing between neighboring lattice points on the unit sphere. */
export const latticeSpacing = (n: number) => Math.sqrt((4 * Math.PI) / n);

/** Degrees to a unit vector. y is up, the prime meridian faces +z. */
export function unitVector(lat: number, lng: number): Vec3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
}

/** Inverse of `unitVector`. Degrees, with lng in [-180, 180). */
export function latLng(v: Vec3): { lat: number; lng: number } {
  const lat = (Math.asin(Math.max(-1, Math.min(1, v[1]))) * 180) / Math.PI;
  let lng = 90 - (Math.atan2(v[2], v[0]) * 180) / Math.PI;
  lng = ((((lng + 180) % 360) + 360) % 360) - 180;
  return { lat, lng };
}
