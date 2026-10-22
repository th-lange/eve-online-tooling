import { useEffect, useRef, useState, type RefObject } from "react";
import { BASE_RGB, CONTEST_RGB, HEAT_RGB } from "./fwConstants";

/**
 * A tile's solid background: the contest-state base, deepened toward red as the
 * system's kills approach the warzone's busiest. Quiet uncontested systems keep
 * the default (transparent) background.
 */
export function tileBg(
  contested: string,
  kills: number,
  maxKills: number,
): string | undefined {
  const base = CONTEST_RGB[contested] ?? BASE_RGB;
  const t = Math.min(1, kills / Math.max(10, maxKills)) * 0.75;
  if (t <= 0) {
    return contested === "uncontested" ? undefined : `rgb(${base.join(",")})`;
  }
  const mix = base.map((c, i) => Math.round(c + (HEAT_RGB[i] - c) * t));
  return `rgb(${mix.join(",")})`;
}

/**
 * Snap coordinate-placed tiles onto a grid so none overlap: each tile takes its
 * nearest cell, and collisions spiral out to the closest free one. Keeps the
 * rough geography while guaranteeing clear spacing. Pure.
 */
export function spreadNoOverlap(
  points: { id: string; x: number; y: number }[],
  cellW: number,
  cellH: number,
): Map<string, { x: number; y: number }> {
  const order = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
  const taken = new Set<string>();
  const out = new Map<string, { x: number; y: number }>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (const p of order) {
    let cx = Math.round(p.x / cellW);
    let cy = Math.round(p.y / cellH);
    if (taken.has(key(cx, cy))) {
      let done = false;
      for (let r = 1; r < 300 && !done; r++) {
        for (let dx = -r; dx <= r && !done; dx++) {
          for (let dy = -r; dy <= r && !done; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
            if (!taken.has(key(cx + dx, cy + dy))) {
              cx += dx;
              cy += dy;
              done = true;
            }
          }
        }
      }
    }
    taken.add(key(cx, cy));
    out.set(p.id, { x: cx * cellW, y: cy * cellH });
  }
  return out;
}

/**
 * "Fill" map size (#897): grows the map to the remaining viewport height
 * below its own top edge, tracking window resizes so it never needs a page
 * reload to re-fit. Inactive presets skip the resize listener entirely.
 */
export function useFillHeight(
  active: boolean,
  minHeight: number,
): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(minHeight);
  useEffect(() => {
    if (!active) return;
    const compute = () => {
      const top = ref.current?.getBoundingClientRect().top ?? 0;
      // 16px breathing room below the map so it doesn't touch the viewport edge.
      setHeight(Math.max(minHeight, window.innerHeight - top - 16));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [active, minHeight]);
  return [ref, height];
}
