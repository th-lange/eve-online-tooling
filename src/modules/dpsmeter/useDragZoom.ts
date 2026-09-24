import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** Drag-to-select a horizontal range on the playback overview strip. On
 *  release it reports the selected range as start/end **fractions** (0..1)
 *  across the SVG width via `onSelect` — the caller maps those to log
 *  timestamps against whatever window it's currently showing (so selecting
 *  works precisely, and nests when already zoomed).
 *
 *  Uses Pointer Events with `setPointerCapture`, not mouse events: capture
 *  routes every subsequent `pointermove`/`pointerup` back to the SVG even
 *  when the pointer leaves its bounds, and it behaves identically across
 *  WebKit (Tauri's Linux/macOS webview), Blink and Gecko — unlike the
 *  `document`-level mouse-listener pattern, which WebKitGTK does not track
 *  reliably through a drag that started with `preventDefault`.
 *
 *  Returns the live drag box in viewBox x-coordinates (for the highlight
 *  rect) plus the pointer handlers to spread onto the `<svg>`. */
export function useDragZoom(
  svgRef: { current: SVGSVGElement | null },
  w: number,
  onSelect?: (startFrac: number, endFrac: number) => void,
) {
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const x0Ref = useRef(0);
  const draggingRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const toSvgX = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * w;
  };

  const handlers = onSelect
    ? {
        onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => {
          if (e.button !== 0) return; // left button only
          e.currentTarget.setPointerCapture(e.pointerId);
          const x = toSvgX(e.clientX);
          x0Ref.current = x;
          draggingRef.current = true;
          setDrag({ x0: x, x1: x });
          e.preventDefault();
        },
        onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => {
          if (!draggingRef.current) return;
          setDrag({ x0: x0Ref.current, x1: toSvgX(e.clientX) });
        },
        onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          const x1 = toSvgX(e.clientX);
          setDrag(null);
          const lo = Math.min(x0Ref.current, x1);
          const hi = Math.max(x0Ref.current, x1);
          // Ignore a click / hair-thin drag (< 1% of width).
          if (hi - lo < w * 0.01) return;
          onSelectRef.current?.(lo / w, hi / w);
        },
        onPointerCancel: () => {
          draggingRef.current = false;
          setDrag(null);
        },
      }
    : undefined;

  return { drag, handlers };
}
