/**
 * The globe: a WebGL2 context, an orbit camera, and the passes that draw into it.
 *
 * The globe renders on demand. It draws one frame when something changes, then stops. While
 * nothing changes, it schedules no frame and uses no CPU. Auto-rotation and inertia are the two
 * states that keep frames coming, and both end on their own.
 */

import { view, project as projectPoint, unproject, MAX_LAT, type Camera, type View } from './camera';
import { createSpherePass, type SphereStyle } from './sphere';
import { createMarkerPass, type Marker, type MarkerPass } from './markers';
import { createArcPass, pathSegments, barArcs, pickArc, type Arc, type ArcPass, type Path, type Bar } from './arcs';
import { createRingPass, type Ring, type RingPass } from './rings';
import { createLabelLayer, type Label, type LabelLayer, type LabelOptions } from './labels';
import { unitVector } from './fibonacci';
import { subsolarPoint, wrapLng } from './geo';
import { countryIndex, type CountryIndex } from './countries';
import type { AreaGeometry } from './landmask';

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
  /** Resolves when the globe has painted its first frame. It rejects when the shader fails. */
  readonly ready: Promise<void>;
  /** Draw one frame now. */
  render(): void;
  /** Ask for one frame on the next tick. Calling it many times still draws one frame. */
  invalidate(): void;
  setCamera(next: Partial<Camera>): void;
  /**
   * Move the camera to a place over `ms` milliseconds, with an ease in and out. Longitude takes
   * the short way around. 0 ms jumps. A drag or a new flight cancels the one in progress, and
   * the promise then resolves false.
   */
  flyTo(target: Partial<Camera>, ms?: number): Promise<boolean>;
  setStyle(next: Partial<SphereStyle>): void;
  setLand(data: Uint8Array | null, width: number, height: number): void;
  setTint(data: Uint8Array | null, width: number, height: number): void;
  setAutoRotate(degreesPerSecond: number): void;
  /** Put the sun over a place, or over where it is at a moment in time. Set `style.night` to see it. */
  setSun(at: Date | { lat: number; lng: number }): void;
  /**
   * One value in 0..1 for each lattice dot, for `dots` dots. A dot grows and takes
   * `style.dataColor` with its value. Build the values with `binPoints`. Null clears it.
   */
  setDotData(values: Float32Array | null, dots: number): void;
  setMarkers(markers: readonly Marker[]): void;
  setArcs(arcs: readonly Arc[]): void;
  /** Lines that follow the surface, for a cable or a route. */
  setPaths(paths: readonly Path[]): void;
  /** Bars that rise from a place, sized by a value. */
  setBars(bars: readonly Bar[]): void;
  /** Pulsing rings. While any ring exists the globe keeps drawing, because they animate. */
  setRings(rings: readonly Ring[]): void;
  /** Country shapes that `pick` tests. Pass the GeoJSON geometry of each country, in order. */
  setCountries(geometries: readonly AreaGeometry[] | null): void;
  /**
   * HTML labels that follow places. The globe puts them in a layer over the canvas and hides each
   * one that the globe covers. Labels that would overlap hide too, lowest priority first.
   */
  setLabels(labels: readonly Label[], options?: LabelOptions): void;
  /** Screen position of a place, in CSS pixels. Use it to pin an HTML element. */
  project(lat: number, lng: number, altitude?: number): { x: number; y: number; visible: boolean };
  /**
   * What is under a point, in CSS pixels. Null when the point misses the globe. A point past the
   * limb can still sit on an arc, and then `lat` and `lng` are NaN.
   */
  pick(x: number, y: number): Pick | null;
  /** Listen for an event. Returns a function that removes the listener. */
  on<K extends keyof GlobeEvents>(type: K, fn: (event: GlobeEvents[K]) => void): () => void;
  off<K extends keyof GlobeEvents>(type: K, fn: (event: GlobeEvents[K]) => void): void;
  /** The globe as an image. Draws one frame and reads it back. */
  toBlob(type?: string, quality?: number): Promise<Blob | null>;
  destroy(): void;
}

export interface Pick {
  lat: number;
  lng: number;
  /** Index of the marker under the point, or -1 when the point hit no marker. */
  marker: number;
  /** Index into the array given to `setCountries`, or -1 for none and when none were set. */
  country: number;
  /** Index of the arc under the point, or -1. */
  arc: number;
}

export interface PickEvent extends Pick {
  /** Pointer position, in CSS pixels from the top left of the canvas. */
  x: number;
  y: number;
  event: MouseEvent;
}

export interface GlobeEvents {
  /** A press and release that did not move. Null when the pointer missed the globe. */
  click: PickEvent | null;
  rightclick: PickEvent | null;
  /** The pointer moved over the globe. Null once, when it leaves the globe. */
  hover: PickEvent | null;
  /** The camera moved. Fires once for each frame that drew a new camera. */
  camera: Readonly<Camera>;
  /** The passes drew. Draw your own WebGL layer here, with `globe.gl` and this view. */
  draw: View;
  /** A frame finished. */
  render: void;
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
  let sphere = createSpherePass(gl, options.style);
  const listeners = new Map<string, Set<(event: any) => void>>();
  const emit = (type: keyof GlobeEvents, event: unknown) => listeners.get(type)?.forEach((fn) => fn(event));

  // The marker pass is built on the first setMarkers call. A globe with no marker never compiles
  // that shader, which keeps its first frame shorter.
  let markerPass: MarkerPass | null = null;
  let arcPass: ArcPass | null = null;
  let ringPass: RingPass | null = null;
  let pathPass: ArcPass | null = null;
  let barPass: ArcPass | null = null;
  let labelLayer: LabelLayer | null = null;
  let markerList: readonly Marker[] = [];
  let markerPoints: Float32Array = new Float32Array(0); // unit vectors, for pick
  let countries: CountryIndex | null = null;

  /*
   * Everything a setter received, so the globe can build itself again after the browser drops
   * the WebGL context. That happens on a page with many contexts, and on a mobile tab that
   * comes back from the background.
   */
  const stash = {
    style: { ...options.style } as Partial<SphereStyle>,
    land: null as [Uint8Array | null, number, number] | null,
    tint: null as [Uint8Array | null, number, number] | null,
    sun: null as [number, number] | null,
    dotData: null as [Float32Array | null, number] | null,
    arcs: [] as readonly Arc[],
    paths: [] as readonly Path[],
    bars: [] as readonly Bar[],
    rings: [] as readonly Ring[],
  };

  let autoRotate = options.autoRotate ?? 0;
  let width = 1, height = 1; // CSS pixels
  let frame = 0;
  let lastTime = 0;
  let spin = 0; // degrees per second, left over from a drag
  let destroyed = false;
  let lost = false; // the browser took the context away, and did not give it back yet
  let offscreen = false; // nothing draws while the canvas is out of view
  let pending = false; // a frame was asked for, but the shader was not linked yet
  let clock = 0; // seconds since the first frame, for anything that animates
  let flight: { from: Camera; to: Camera; start: number; ms: number; done: (reached: boolean) => void } | null = null;
  const lastDrawn: Camera = { lat: NaN, lng: NaN, altitude: NaN };

  /*
   * Honor the OS setting. When it asks for less motion the globe still draws every layer, but
   * nothing moves on its own: no rotation, a ring and a dash hold one phase, and a flight jumps.
   */
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) clock = 1.5; // a ring at half radius, which reads as a ring and not as nothing

  let settleReady!: () => void;
  let failReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { settleReady = resolve; failReady = reject; });
  ready.catch(() => {}); // a caller that ignores `ready` must not raise an unhandled rejection

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
    if (destroyed || lost) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const v = currentView();
    let sphereDrew: boolean;
    let layersDrew: boolean;
    try {
      /*
       * Each pass draws as soon as its own shader is linked. The globe does not wait for the
       * whole set, because the driver compiles each shader separately and the sphere is what a
       * visitor waits for. A marker or an arc appears one frame after its shader is ready.
       */
      sphereDrew = sphere.draw(v, canvas.height);
      layersDrew = (!barPass || barPass.draw(v, [canvas.width, canvas.height], clock))
        && (!pathPass || pathPass.draw(v, [canvas.width, canvas.height], clock))
        && (!arcPass || arcPass.draw(v, [canvas.width, canvas.height], clock))
        && (!ringPass || ringPass.draw(v, clock))
        && (!markerPass || markerPass.draw(v));
    } catch (error) {
      destroyed = true;
      failReady(error);
      throw error;
    }
    // Keep asking for frames until every pass has drawn at least one.
    pending = !sphereDrew || !layersDrew;
    if (!sphereDrew) return;
    settleReady();
    emit('draw', v);
    labelLayer?.update((lat, lng, alt) => projectPoint(v, lat, lng, alt, width, height));
    if (camera.lat !== lastDrawn.lat || camera.lng !== lastDrawn.lng || camera.altitude !== lastDrawn.altitude) {
      Object.assign(lastDrawn, camera);
      emit('camera', camera);
    }
    emit('render', undefined);
  }

  function tick(now: number) {
    frame = 0;
    const dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0;
    lastTime = now;

    if (!reducedMotion) clock += dt;
    // What keeps frames coming on its own: a pulse, a travelling dash, a flight, and the two
    // camera motions below. Each one ends, and then the loop stops.
    let moving = !reducedMotion && ((ringPass !== null && ringPass.count > 0)
      || (arcPass !== null && (arcPass.animated || clock < arcPass.until))
      || (pathPass !== null && (pathPass.animated || clock < pathPass.until)));

    if (flight) {
      if (flight.start < 0) flight.start = now;
      const t = Math.min(1, (now - flight.start) / flight.ms);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in and out
      camera.lat = flight.from.lat + (flight.to.lat - flight.from.lat) * e;
      camera.lng = flight.from.lng + (flight.to.lng - flight.from.lng) * e;
      camera.altitude = flight.from.altitude + (flight.to.altitude - flight.from.altitude) * e;
      if (t >= 1) { flight.done(true); flight = null; } else moving = true;
    }

    if (autoRotate !== 0 && !reducedMotion) {
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
    // Schedule the next frame only while something still moves, or while the shader is not
    // linked. Otherwise the loop ends here and the globe uses no CPU.
    if ((moving || pending) && !offscreen) frame = requestAnimationFrame(tick);
    else lastTime = 0;
  }

  function invalidate() {
    if (destroyed || frame || offscreen) return;
    frame = requestAnimationFrame(tick);
  }

  function cancelFlight() {
    flight?.done(false);
    flight = null;
  }

  /** What is under a pointer event, for a listener. */
  function pickAt(e: MouseEvent): PickEvent | null {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const p = api.pick(x, y);
    return p && { ...p, x, y, event: e };
  }

  // Pointer control: drag to turn, wheel or pinch to zoom, arrow keys to turn, + and - to zoom.
  let dragging = false;
  let lastX = 0, lastY = 0, lastMove = 0;
  let downX = 0, downY = 0, downTime = 0; // where the press began, to tell a click from a drag
  let hovering = false; // the last hover event was over the globe
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchStart = 0; // distance between two pointers when the pinch began
  let pinchAltitude = 0;

  const onPointerDown = (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      pinchAltitude = camera.altitude;
      dragging = false; // two fingers zoom, they do not turn
      return;
    }
    cancelFlight();
    dragging = true;
    spin = 0;
    lastX = downX = e.clientX;
    lastY = downY = e.clientY;
    lastMove = downTime = e.timeStamp;
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart > 0) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      camera.altitude = clampAltitude(pinchAltitude * (pinchStart / Math.max(1, d)));
      invalidate();
      return;
    }
    if (!dragging) {
      // A pick costs one pass over the markers, so it runs only for a listener that wants it.
      if (!listeners.get('hover')?.size && !listeners.get('click')?.size) return;
      const p = pickAt(e);
      canvas.style.cursor = p && (p.marker >= 0 || p.arc >= 0) && listeners.get('click')?.size ? 'pointer' : '';
      if (p || hovering) emit('hover', p);
      hovering = p !== null;
      return;
    }
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
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = 0;
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    // A pointer that rested before it lifted must not throw the globe.
    if (e.timeStamp - lastMove > 80) spin = 0;
    // A short press that stayed put is a click.
    if (e.type === 'pointerup' && Math.hypot(e.clientX - downX, e.clientY - downY) < 4
      && e.timeStamp - downTime < 500 && listeners.get('click')?.size) emit('click', pickAt(e));
    invalidate();
  };

  const onPointerLeave = () => {
    if (hovering) emit('hover', null);
    hovering = false;
    canvas.style.cursor = '';
  };

  const onContextMenu = (e: MouseEvent) => {
    if (!listeners.get('rightclick')?.size) return;
    e.preventDefault();
    emit('rightclick', pickAt(e));
  };

  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 5;
    switch (e.key) {
      case "ArrowLeft": camera.lng -= step; break;
      case "ArrowRight": camera.lng += step; break;
      case "ArrowUp": camera.lat = Math.min(MAX_LAT, camera.lat + step); break;
      case "ArrowDown": camera.lat = Math.max(-MAX_LAT, camera.lat - step); break;
      case "+": case "=": camera.altitude = clampAltitude(camera.altitude * 0.85); break;
      case "-": case "_": camera.altitude = clampAltitude(camera.altitude / 0.85); break;
      default: return;
    }
    e.preventDefault();
    cancelFlight();
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
    canvas.addEventListener('keydown', onKey);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.style.touchAction = 'none'; // the browser must not scroll the page on a drag
    if (canvas.tabIndex < 0) canvas.tabIndex = 0; // a canvas takes keys only when it can take focus
  }

  const onContextLost = (e: Event) => {
    e.preventDefault(); // tells the browser that the page wants the context back
    lost = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const onContextRestored = () => {
    // Every GPU object died with the old context. Build each pass again from the stash. The old
    // pass objects are not destroyed, because their handles belong to a context that is gone.
    lost = false;
    sphere = createSpherePass(gl, stash.style);
    if (stash.land) sphere.setLand(...stash.land);
    if (stash.tint) sphere.setTint(...stash.tint);
    if (stash.sun) sphere.setSun(...stash.sun);
    if (stash.dotData) sphere.setDotData(...stash.dotData);
    markerPass = arcPass = ringPass = pathPass = barPass = null;
    if (markerList.length) api.setMarkers(markerList);
    if (stash.arcs.length) api.setArcs(stash.arcs);
    if (stash.paths.length) api.setPaths(stash.paths);
    if (stash.bars.length) api.setBars(stash.bars);
    if (stash.rings.length) api.setRings(stash.rings);
    invalidate();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  observer?.observe(canvas);
  // A globe that scrolled out of view draws nothing, and its animations wait.
  const visibility = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
    offscreen = !entries[entries.length - 1].isIntersecting;
    if (!offscreen) invalidate();
  });
  visibility?.observe(canvas);
  resize();

  const api: Globe = {
    gl,
    ready,
    get camera() { return camera; },
    render,
    invalidate,
    setCamera(next) {
      cancelFlight();
      if (next.lat !== undefined) camera.lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, next.lat));
      if (next.lng !== undefined) camera.lng = next.lng;
      if (next.altitude !== undefined) camera.altitude = clampAltitude(next.altitude);
      invalidate();
    },
    flyTo(target, ms = 1000) {
      cancelFlight();
      const to: Camera = {
        lat: Math.max(-MAX_LAT, Math.min(MAX_LAT, target.lat ?? camera.lat)),
        lng: target.lng === undefined ? camera.lng : camera.lng + wrapLng(target.lng - camera.lng),
        altitude: clampAltitude(target.altitude ?? camera.altitude),
      };
      if (ms <= 0 || reducedMotion) { Object.assign(camera, to); invalidate(); return Promise.resolve(true); }
      spin = 0;
      invalidate();
      return new Promise((done) => { flight = { from: { ...camera }, to, start: -1, ms, done }; });
    },
    setStyle(next) { Object.assign(stash.style, next); sphere.setStyle(next); invalidate(); },
    setLand(data, w, h) { stash.land = [data, w, h]; sphere.setLand(data, w, h); invalidate(); },
    setTint(data, w, h) { stash.tint = [data, w, h]; sphere.setTint(data, w, h); invalidate(); },
    setAutoRotate(speed) { autoRotate = speed; invalidate(); },
    setDotData(values, dots) { stash.dotData = [values, dots]; sphere.setDotData(values, dots); invalidate(); },
    setSun(at) {
      const p = at instanceof Date ? subsolarPoint(at) : at;
      stash.sun = [p.lat, p.lng];
      sphere.setSun(p.lat, p.lng);
      invalidate();
    },
    setMarkers(markers) {
      markerPass ??= createMarkerPass(gl);
      markerPass.set(markers);
      markerList = markers;
      // Keep the unit vector of each marker, so pick() needs no trigonometry for each marker.
      markerPoints = new Float32Array(markers.length * 3);
      for (let i = 0; i < markers.length; i++) {
        const v = unitVector(markers[i].lat, markers[i].lng);
        markerPoints[i * 3] = v[0];
        markerPoints[i * 3 + 1] = v[1];
        markerPoints[i * 3 + 2] = v[2];
      }
      invalidate();
    },
    setArcs(arcs) {
      stash.arcs = arcs;
      arcPass ??= createArcPass(gl);
      arcPass.set(arcs, reducedMotion ? null : clock);
      invalidate();
    },
    setPaths(paths) {
      stash.paths = paths;
      // A path segment is short and nearly straight, so it needs far fewer steps than an arc.
      pathPass ??= createArcPass(gl, { segments: 6 });
      pathPass.set(pathSegments(paths), reducedMotion ? null : clock);
      invalidate();
    },
    setBars(bars) {
      stash.bars = bars;
      barPass ??= createArcPass(gl, { segments: 1 }); // a bar is straight
      barPass.set(barArcs(bars));
      invalidate();
    },
    setRings(rings) {
      stash.rings = rings;
      ringPass ??= createRingPass(gl);
      ringPass.set(rings);
      invalidate();
    },
    setCountries(geometries) {
      countries = geometries && geometries.length ? countryIndex(geometries) : null;
    },
    setLabels(labels, options) {
      labelLayer ??= createLabelLayer(canvas);
      labelLayer.set(labels, options);
      invalidate();
    },
    project(lat, lng, altitude = 0) { return projectPoint(currentView(), lat, lng, altitude, width, height); },
    pick(x, y) {
      const v = currentView();
      const arc = stash.arcs.length ? pickArc(stash.arcs, v, x, y, width, height) : -1;
      const place = unproject(v, x, y, width, height);
      // An arc rises above the surface, so a point past the limb can still sit on one.
      if (!place) return arc >= 0 ? { lat: NaN, lng: NaN, marker: -1, country: -1, arc } : null;

      // Nearest marker, by straight-line distance on the sphere. A marker counts as hit when the
      // point falls inside its radius. One pass over the list, with no allocation.
      const p = unitVector(place.lat, place.lng);
      let marker = -1;
      let best = Infinity;
      for (let i = 0; i < markerList.length; i++) {
        const dx = p[0] - markerPoints[i * 3];
        const dy = p[1] - markerPoints[i * 3 + 1];
        const dz = p[2] - markerPoints[i * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        const r = markerList[i].size ?? 0.01;
        if (d < r * r && d < best) { best = d; marker = i; }
      }

      const country = countries ? countries.locate(place.lat, place.lng) : -1;
      return { lat: place.lat, lng: place.lng, marker, country, arc };
    },
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, set = new Set());
      set.add(fn);
      return () => { set.delete(fn); };
    },
    off(type, fn) { listeners.get(type)?.delete(fn); },
    toBlob(type, quality) {
      // The read must follow the draw in the same task, because the buffer clears after it.
      render();
      return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    },
    destroy() {
      destroyed = true;
      cancelFlight();
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      visibility?.disconnect();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      if (interactive) {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('keydown', onKey);
        canvas.removeEventListener('pointerleave', onPointerLeave);
        canvas.removeEventListener('contextmenu', onContextMenu);
      }
      sphere.destroy();
      markerPass?.destroy();
      arcPass?.destroy();
      ringPass?.destroy();
      pathPass?.destroy();
      barPass?.destroy();
      labelLayer?.destroy();
      listeners.clear();
    },
  };
  return api;
}
