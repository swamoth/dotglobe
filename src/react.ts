/**
 * The React binding. One hook, and nothing else.
 *
 * The hook owns the lifetime of the globe: it builds one when the canvas mounts and destroys it
 * when the canvas unmounts. `markers` and `arcs` are declarative, because a React caller expects
 * to pass data and not to call a setter. Everything else stays on the returned globe, so the
 * binding adds no second way to do the same thing.
 *
 * React is a peer dependency, and this module is a separate entry point. The core never imports
 * it, thus a caller who does not use React pays nothing.
 */

import { useEffect, useRef, useState } from 'react';
import { createGlobe, type Globe, type GlobeOptions } from './globe';
import type { Marker } from './markers';
import type { Arc } from './arcs';

export interface UseGlobeOptions extends GlobeOptions {
  markers?: readonly Marker[];
  arcs?: readonly Arc[];
}

export interface UseGlobeResult {
  /** Put this on the canvas: `<canvas ref={ref} />`. */
  ref: React.RefObject<HTMLCanvasElement | null>;
  /** Null until the canvas mounts. Use it for project, pick, and the camera. */
  globe: Globe | null;
}

export function useGlobe(options: UseGlobeOptions = {}): UseGlobeResult {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [globe, setGlobe] = useState<Globe | null>(null);

  // The globe is built once. Later option changes go through a setter, never a rebuild.
  const initial = useRef(options);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const instance = createGlobe(canvas, initial.current);
    setGlobe(instance);
    return () => {
      instance.destroy();
      setGlobe(null);
    };
  }, []);

  const { markers, arcs, autoRotate, style, camera } = options;

  useEffect(() => { if (globe && markers) globe.setMarkers(markers); }, [globe, markers]);
  useEffect(() => { if (globe && arcs) globe.setArcs(arcs); }, [globe, arcs]);
  useEffect(() => { if (globe && autoRotate !== undefined) globe.setAutoRotate(autoRotate); }, [globe, autoRotate]);
  useEffect(() => { if (globe && style) globe.setStyle(style); }, [globe, style]);
  useEffect(() => { if (globe && camera) globe.setCamera(camera); }, [globe, camera]);

  return { ref, globe };
}
