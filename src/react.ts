/**
 * The React binding. One hook, and nothing else.
 *
 * The hook owns the lifetime of the globe: it builds one when the canvas mounts and destroys it
 * when the canvas unmounts. The data layers and the two pointer events are declarative, because
 * a React caller expects to pass data and not to call a setter. Everything else stays on the
 * returned globe, so the binding adds no second way to do the same thing.
 *
 * React is a peer dependency, and this module is a separate entry point. The core never imports
 * it, thus a caller who does not use React pays nothing.
 */

import { useEffect, useRef, useState } from 'react';
import { createGlobe, type Globe, type GlobeOptions, type PickEvent } from './globe';
import type { Marker } from './markers';
import type { Arc, Path, Bar } from './arcs';
import type { Ring } from './rings';
import type { Label } from './labels';

export interface UseGlobeOptions extends GlobeOptions {
  markers?: readonly Marker[];
  arcs?: readonly Arc[];
  paths?: readonly Path[];
  bars?: readonly Bar[];
  rings?: readonly Ring[];
  labels?: readonly Label[];
  onClick?: (event: PickEvent | null) => void;
  onHover?: (event: PickEvent | null) => void;
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

  const { markers, arcs, paths, bars, rings, labels, autoRotate, style, camera, onClick, onHover } = options;

  useEffect(() => { if (globe && markers) globe.setMarkers(markers); }, [globe, markers]);
  useEffect(() => { if (globe && arcs) globe.setArcs(arcs); }, [globe, arcs]);
  useEffect(() => { if (globe && paths) globe.setPaths(paths); }, [globe, paths]);
  useEffect(() => { if (globe && bars) globe.setBars(bars); }, [globe, bars]);
  useEffect(() => { if (globe && rings) globe.setRings(rings); }, [globe, rings]);
  useEffect(() => { if (globe && labels) globe.setLabels(labels); }, [globe, labels]);
  useEffect(() => { if (globe && autoRotate !== undefined) globe.setAutoRotate(autoRotate); }, [globe, autoRotate]);
  useEffect(() => { if (globe && style) globe.setStyle(style); }, [globe, style]);
  useEffect(() => { if (globe && camera) globe.setCamera(camera); }, [globe, camera]);
  useEffect(() => (globe && onClick ? globe.on('click', onClick) : undefined), [globe, onClick]);
  useEffect(() => (globe && onHover ? globe.on('hover', onHover) : undefined), [globe, onHover]);

  return { ref, globe };
}
