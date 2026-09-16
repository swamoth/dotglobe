import { describe, expect, it } from 'vitest';
import { project, raySphere, unproject, view, type Camera } from '../src/camera';
import { unitVector } from '../src/fibonacci';

const W = 800, H = 600;
const CAM: Camera = { lat: 20, lng: -30, altitude: 1.5 };
const V = view(CAM, W / H);

describe('orbit camera', () => {
  it('puts the place under the camera at the center of the screen', () => {
    const p = project(V, CAM.lat, CAM.lng, 0, W, H);
    expect(p.x).toBeCloseTo(W / 2, 6);
    expect(p.y).toBeCloseTo(H / 2, 6);
    expect(p.visible).toBe(true);
  });

  it('round-trips a pixel through unproject and project', () => {
    for (const [x, y] of [[400, 300], [430, 280], [360, 340], [400, 220], [470, 360]]) {
      const place = unproject(V, x, y, W, H);
      expect(place, `pixel ${x},${y} missed the globe`).not.toBeNull();
      const back = project(V, place!.lat, place!.lng, 0, W, H);
      expect(back.x).toBeCloseTo(x, 4);
      expect(back.y).toBeCloseTo(y, 4);
      expect(back.visible).toBe(true);
    }
  });

  it('returns null for a pixel that misses the globe', () => {
    expect(unproject(V, 0, 0, W, H)).toBeNull();
    expect(unproject(V, W - 1, H - 1, W, H)).toBeNull();
  });

  it('hides a place on the far side', () => {
    const far = project(V, -CAM.lat, CAM.lng + 180, 0, W, H);
    expect(far.visible).toBe(false);
  });

  it('shows a point that clears the limb, and hides the same point on the surface', () => {
    // A place a little past the horizon: hidden on the surface, visible when lifted high.
    const lng = CAM.lng + 96;
    expect(project(V, CAM.lat, lng, 0, W, H).visible).toBe(false);
    expect(project(V, CAM.lat, lng, 0.4, W, H).visible).toBe(true);
  });

  it('misses the sphere with a ray that points away from it', () => {
    expect(raySphere([0, 0, 3], [0, 0, 1])).toBe(-1);
    expect(raySphere([0, 0, 3], [0, 0, -1])).toBeCloseTo(2, 9);
  });

  it('keeps the camera off the pole, so the up vector stays defined', () => {
    const polar = view({ lat: 90, lng: 0, altitude: 1 }, 1);
    for (const n of [...polar.right, ...polar.up]) expect(Number.isFinite(n)).toBe(true);
    expect(Math.hypot(...polar.right)).toBeCloseTo(1, 9);
  });

  it('shrinks the globe on the screen as the camera moves out', () => {
    const near = project(view({ lat: 0, lng: 0, altitude: 0.5 }, 1), 0, 20, 0, 600, 600);
    const far = project(view({ lat: 0, lng: 0, altitude: 3 }, 1), 0, 20, 0, 600, 600);
    expect(Math.abs(near.x - 300)).toBeGreaterThan(Math.abs(far.x - 300));
  });
});
