/**
 * HTML labels that follow places on the globe.
 *
 * A label is a DOM element in a layer over the canvas. Each frame moves every label to the
 * screen position of its place with one transform, and hides the ones the globe covers. Text
 * stays crisp at any zoom, takes the page font and CSS, and reads to a screen reader.
 *
 * Labels that would overlap hide too. The layer keeps the boxes it placed this frame and skips a
 * label whose box crosses one of them, highest priority first.
 */

export interface Label {
  lat: number;
  lng: number;
  /** The text of a new element. Leave it out when you give `element`. */
  text?: string;
  /** Your own element. The layer moves it and keeps everything else. */
  element?: HTMLElement;
  /** Height above the surface, in globe radii. The default is 0. */
  altitude?: number;
  /** A label with a higher priority wins an overlap. The default is 0. */
  priority?: number;
  /** A class for a new element. */
  className?: string;
}

export interface LabelOptions {
  /** Hide labels that overlap. The default is true. */
  declutter?: boolean;
}

export interface LabelLayer {
  set(labels: readonly Label[], options?: LabelOptions): void;
  update(project: (lat: number, lng: number, altitude: number) => { x: number; y: number; visible: boolean }): void;
  /** Show a tooltip next to a point, or hide it with null. */
  tip(text: string | null, x: number, y: number): void;
  destroy(): void;
}

interface Item { label: Label; el: HTMLElement; w: number; h: number }

export function createLabelLayer(canvas: HTMLCanvasElement): LabelLayer {
  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
  const parent = canvas.parentElement ?? document.body;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  parent.insertBefore(root, canvas.nextSibling);

  let items: Item[] = [];
  let declutter = true;
  let tooltip: HTMLElement | null = null;

  return {
    tip(text, x, y) {
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'globedots-tooltip';
        tooltip.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;white-space:nowrap';
        root.append(tooltip);
        // A page that styles the class keeps its look. Otherwise a plain default applies.
        if (getComputedStyle(tooltip).backgroundColor === 'rgba(0, 0, 0, 0)') {
          tooltip.style.cssText += ';padding:4px 8px;border-radius:4px;background:#14161a;color:#e6e6e6;font:12px/1.4 system-ui,sans-serif';
        }
      }
      tooltip.style.display = text === null ? 'none' : '';
      if (text === null) return;
      tooltip.textContent = text;
      tooltip.style.transform = `translate(${x + 12}px,${y + 12}px)`;
    },
    set(labels, options = {}) {
      declutter = options.declutter ?? true;
      root.replaceChildren();
      if (tooltip) root.append(tooltip);
      items = labels.map((label) => {
        const el = label.element ?? document.createElement('div');
        if (label.text !== undefined) el.textContent = label.text;
        if (label.className) el.className = label.className;
        el.style.position = 'absolute';
        el.style.left = el.style.top = '0';
        el.style.whiteSpace = 'nowrap';
        el.style.pointerEvents = 'auto';
        root.append(el);
        return { label, el, w: 0, h: 0 };
      });
      // Measure once, after every element is in the page, so the layout runs one time.
      for (const it of items) { it.w = it.el.offsetWidth; it.h = it.el.offsetHeight; }
      items.sort((a, b) => (b.label.priority ?? 0) - (a.label.priority ?? 0));
    },
    update(project) {
      const placed: number[] = []; // x0, y0, x1, y1 of each label shown this frame
      for (const it of items) {
        const p = project(it.label.lat, it.label.lng, it.label.altitude ?? 0);
        let show = p.visible;
        if (show && declutter) {
          const x0 = p.x - it.w / 2, y0 = p.y - it.h / 2, x1 = x0 + it.w, y1 = y0 + it.h;
          // ponytail: a scan over the boxes placed so far, a grid if a page shows thousands
          for (let i = 0; i < placed.length; i += 4) {
            if (x0 < placed[i + 2] && x1 > placed[i] && y0 < placed[i + 3] && y1 > placed[i + 1]) { show = false; break; }
          }
          if (show) placed.push(x0, y0, x1, y1);
        }
        it.el.style.display = show ? '' : 'none';
        if (show) it.el.style.transform = `translate(${p.x}px,${p.y}px) translate(-50%,-50%)`;
      }
    },
    destroy() { root.remove(); },
  };
}
