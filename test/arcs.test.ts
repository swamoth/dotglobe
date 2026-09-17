import { describe, expect, it } from 'vitest';
import { pathSegments, pickArc, prepareArcs } from '../src/arcs';
import { view, project } from '../src/camera';

describe('pathSegments', () => {
  it('spreads the appear time along the path, then the vanish time', () => {
    const [a, b] = pathSegments([{ points: [[0, 0], [0, 10], [0, 20]], appear: 1000, vanish: 500 }]);
    expect(a.appear).toBe(500);
    expect(a.delay).toBe(0);
    expect(b.delay).toBe(500);
    // The whole path is drawn at 1000 ms. Segment a then erases first, and b 250 ms after it.
    expect((a.delay ?? 0) + a.appear! + a.vanishDelay!).toBe(1000);
    expect((b.delay ?? 0) + b.appear! + b.vanishDelay!).toBe(1250);
  });
});

describe('pickArc', () => {
  const arcs = prepareArcs([{ startLat: 0, startLng: 0, endLat: 0, endLng: 90 }]);
  const v = view({ lat: 0, lng: 45, altitude: 1.6 }, 1);

  it('hits the arc at its projected middle and misses a corner', () => {
    // The middle of this arc is at lng 45, lifted by its clearance, straight ahead of the camera.
    const mid = project(v, 0, 45, 0.06, 400, 400);
    expect(pickArc(arcs, v, mid.x, mid.y, 400, 400)).toBe(0);
    expect(pickArc(arcs, v, 5, 5, 400, 400)).toBe(-1);
  });

  it('does not hit an arc behind the globe', () => {
    const back = view({ lat: 0, lng: -135, altitude: 1.6 }, 1);
    expect(pickArc(arcs, back, 200, 200, 400, 400)).toBe(-1);
  });
});
