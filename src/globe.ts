/**
 * The globe: a WebGL2 context, an orbit camera, and the passes that draw into it.
 *
 * The globe renders on demand. It draws one frame when something changes, then stops. While
 * nothing changes, it schedules no frame and uses no CPU. Auto-rotation and inertia are the two
 * states that keep frames coming, and both end on their own.
 */

import { view, project as projectPoint, unproject, MAX_LAT, type Camera, type View } from './camera';
import { createSpherePass, type SphereStyle } from './sphere';

export interface GlobeOptions {
  /** Defaults to the device value, capped at 2. A higher value costs fill rate. */
  devicePixelRatio?: number;
  camera?: Partial<Camera>;
  style?: Partial<SphereStyle>;
  /** Degrees of longitude per second. 0 stops the rotation. */
  autoRotate?: number;
  /** Turn the pointer handlers off, to drive the camera from your own code. */
  interactive?: boolean;
  minAltitude?: number;
  maxAltitude?: number;
}

export interface Globe {
  readonly gl: WebGL2RenderingContext;
  readonly camera: Readonly<Camera>;
  /** Draw one frame now. */
  render(): void;
  /** Ask for one frame on the next tick. Calling it many times still draws one frame. */
  invalidate(): void;
  setCamera(next: Partial<Camera>): void;
  setStyle(next: Partial<SphereStyle>): void;
  setLand(data: Uint8Array | null, width: number, height: number): void;
  setTint(data: Uint8Array | null, width: number, height: number): void;
  setAutoRotate(degreesPerSecond: number): void;
  /** Screen position of a place, in CSS pixels. Use it to pin an HTML element. */
  project(lat: number, lng: number, altitude?: number): { x: number; y: number; visible: boolean };
  /** The place under a point, in CSS pixels, or null when the point misses the globe. */
  pick(x: number, y: number): { lat: number; lng: number } | null;
  onRender(fn: () => void): void;
  offRender(fn: () => void): void;
  destroy(): void;
}

const DEFAULT_CAMERA: Camera = { lat: 20, lng: 0, altitude: 1.6 };
/** Below this speed the inertia stops and the globe goes quiet. */
const INERTIA_FLOOR = 0.01;
/** Fraction of the spin that is kept each frame after a drag. */
const INERTIA_DECAY = 0.94;

export function createGlobe(canvas: HTMLCanvasElement, options: GlobeOptions = {}): Globe {
  const context = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false, // the shader antialiases the dot edge, so the sample cost buys nothing
    depth: false,
    powerPreference: 'high-performance',
    premultipliedAlpha: true,
  });
  if (!context) throw new Error('dotglobe: this browser has no WebGL2 context.');
  const gl = context;

  const camera: Camera = { ...DEFAULT_CAMERA, ...options.camera };
  const minAltitude = options.minAltitude ?? 0.15;
  const maxAltitude = options.maxAltitude ?? 4;
  const dpr = Math.min(options.devicePixelRatio ?? (globalThis.devicePixelRatio || 1), 2);
  const sphere = createSpherePass(gl, options.style);
  const listeners = new Set<() => void>();

  let autoRotate = options.autoRotate ?? 0;
  let width = 1, height = 1; // CSS pixels
  let frame = 0;
  let lastTime = 0;
  let spin = 0; // degrees per second, left over from a drag
  let destroyed = false;

  const clampAltitude = (a: number) => Math.min(maxAltitude, Math.max(minAltitude, a));
  const currentView = (): View => view(camera, width / height);

  function resize() {
    const w = Math.max(1, canvas.clientWidth || canvas.width);
    const h = Math.max(1, canvas.clientHeight || canvas.height);
    if (w === width && h === height) return;
    width = w;
    height = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    invalidate();
  }

  function render() {
    if (destroyed) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    sphere.draw(currentView());
    for (const fn of listeners) fn();
  }

  function tick(now: number) {
    frame = 0;
    const dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0;
    lastTime = now;

    let moving = false;
    if (autoRotate !== 0) {
      camera.lng += autoRotate * dt;
      moving = true;
    }
    if (Math.abs(spin) > INERTIA_FLOOR) {
      camera.lng += spin * dt;
      spin *= INERTIA_DECAY;
      moving = true;
    } else {
      spin = 0;
    }

    render();
    // Schedule the next frame only while something still moves. Otherwise the loop ends here.
    if (moving) frame = requestAnimationFrame(tick);
    else lastTime = 0;
  }

  function invalidate() {
    if (destroyed || frame) return;
    frame = requestAnimationFrame(tick);
  }

  // Pointer control: drag to turn, wheel to zoom. One pointer at a time.
  let dragging = false;
  let lastX = 0, lastY = 0, lastMove = 0;

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    spin = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    lastMove = e.timeStamp;
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    // One globe radius across the short side of the canvas turns about 180 degrees.
    const scale = 180 / Math.min(width, height);
    const dx = (e.clientX - lastX) * scale;
    const dy = (e.clientY - lastY) * scale;
    camera.lng -= dx;
    camera.lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, camera.lat + dy));

    const dt = Math.max(1, e.timeStamp - lastMove);
    spin = (-dx / dt) * 1000;
    lastX = e.clientX;
    lastY = e.clientY;
    lastMove = e.timeStamp;
    invalidate();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    // A pointer that rested before it lifted must not throw the globe.
    if (e.timeStamp - lastMove > 80) spin = 0;
    invalidate();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    camera.altitude = clampAltitude(camera.altitude * Math.exp(e.deltaY * 0.001));
    invalidate();
  };

  const interactive = options.interactive ?? true;
  if (interactive) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.style.touchAction = 'none'; // the browser must not scroll the page on a drag
  }

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  observer?.observe(canvas);
  resize();

  return {
    gl,
    get camera() { return camera; },
    render,
    invalidate,
    setCamera(next) {
      if (next.lat !== undefined) camera.lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, next.lat));
      if (next.lng !== undefined) camera.lng = next.lng;
      if (next.altitude !== undefined) camera.altitude = clampAltitude(next.altitude);
      invalidate();
    },
    setStyle(next) { sphere.setStyle(next); invalidate(); },
    setLand(data, w, h) { sphere.setLand(data, w, h); invalidate(); },
    setTint(data, w, h) { sphere.setTint(data, w, h); invalidate(); },
    setAutoRotate(speed) { autoRotate = speed; invalidate(); },
    project(lat, lng, altitude = 0) { return projectPoint(currentView(), lat, lng, altitude, width, height); },
    pick(x, y) { return unproject(currentView(), x, y, width, height); },
    onRender(fn) { listeners.add(fn); },
    offRender(fn) { listeners.delete(fn); },
    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      if (interactive) {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
        canvas.removeEventListener('wheel', onWheel);
      }
      sphere.destroy();
      listeners.clear();
    },
  };
}
