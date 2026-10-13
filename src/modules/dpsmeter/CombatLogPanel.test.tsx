import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { DpsEvent } from "../../lib/api";
import { CombatLogPanel } from "./CombatLogPanel";

function ev(ts: number, pilot: string): DpsEvent {
  return {
    ts,
    kind: "damageOut",
    amount: 10,
    pilot,
    ship: null,
    weapon: null,
    quality: "Hits",
    ore: null,
    volume: 0,
  };
}

/** jsdom does no real layout, so scrollTop/scrollHeight/offsetTop/etc. are
 *  always 0 — override them per-instance to simulate a real scrolled list:
 *  `rowHeight`-tall rows stacked in event order inside a `clientHeight`-tall
 *  viewport, scrolled to `scrollTop`. */
function stubGeometry(
  el: HTMLElement,
  {
    scrollTop,
    scrollHeight,
    clientHeight,
    rowHeight = 20,
  }: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    rowHeight?: number;
  },
) {
  Object.defineProperty(el, "scrollTop", {
    value: scrollTop,
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  let i = 0;
  for (const child of el.children) {
    if ((child as HTMLElement).dataset.ts === undefined) continue;
    Object.defineProperty(child, "offsetTop", {
      value: i * rowHeight,
      configurable: true,
    });
    Object.defineProperty(child, "offsetHeight", {
      value: rowHeight,
      configurable: true,
    });
    i++;
  }
}

/** Fire a scroll event and let its rAF-throttled handler (plus any resulting
 *  React state update) flush under fake timers. */
async function scrollAndFlush(list: HTMLElement) {
  await act(async () => {
    fireEvent.scroll(list);
    await vi.advanceTimersByTimeAsync(20);
  });
}

describe("CombatLogPanel scrolling", () => {
  it("reports the bottom-most visible line's time and pauses auto-scroll when scrolled away from the bottom", async () => {
    vi.useFakeTimers();
    try {
      const events = Array.from({ length: 10 }, (_, i) =>
        ev(1000 + i, `p${i}`),
      );
      const onVisiblePositionChange = vi.fn();
      const { container } = render(
        <CombatLogPanel
          events={events}
          collapsed={false}
          onToggleCollapsed={() => {}}
          onVisiblePositionChange={onVisiblePositionChange}
        />,
      );
      const list = container.querySelector(".overflow-y-auto") as HTMLElement;
      // Let the mount-triggered auto-scroll's "this is a programmatic scroll,
      // ignore it" grace window elapse before simulating a real user scroll.
      await act(() => vi.advanceTimersByTimeAsync(650));

      // 10 rows × 20px = 200px content in a 50px viewport, scrolled to 80px:
      // the viewport covers [80, 130), so row 6 (ts 1006, top at 120px) is the
      // bottom-most at-least-partially-visible line.
      stubGeometry(list, {
        scrollTop: 80,
        scrollHeight: 200,
        clientHeight: 50,
      });
      await scrollAndFlush(list);

      expect(onVisiblePositionChange).toHaveBeenCalledWith(1006);
      expect(
        screen.getByRole("checkbox", { name: "Auto-scroll" }),
      ).not.toBeChecked();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the marker and re-enables auto-scroll once scrolled back to the bottom", async () => {
    vi.useFakeTimers();
    try {
      const events = Array.from({ length: 10 }, (_, i) =>
        ev(1000 + i, `p${i}`),
      );
      const onVisiblePositionChange = vi.fn();
      const { container } = render(
        <CombatLogPanel
          events={events}
          collapsed={false}
          onToggleCollapsed={() => {}}
          onVisiblePositionChange={onVisiblePositionChange}
        />,
      );
      const list = container.querySelector(".overflow-y-auto") as HTMLElement;
      await act(() => vi.advanceTimersByTimeAsync(650));

      stubGeometry(list, {
        scrollTop: 80,
        scrollHeight: 200,
        clientHeight: 50,
      });
      await scrollAndFlush(list);
      expect(
        screen.getByRole("checkbox", { name: "Auto-scroll" }),
      ).not.toBeChecked();

      // Scrolled to the very bottom (150px = 200 - 50).
      stubGeometry(list, {
        scrollTop: 150,
        scrollHeight: 200,
        clientHeight: 50,
      });
      await scrollAndFlush(list);

      expect(onVisiblePositionChange).toHaveBeenLastCalledWith(null);
      expect(
        screen.getByRole("checkbox", { name: "Auto-scroll" }),
      ).toBeChecked();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the marker when the panel is collapsed", () => {
    const onVisiblePositionChange = vi.fn();
    const { rerender } = render(
      <CombatLogPanel
        events={[ev(1000, "a")]}
        collapsed={false}
        onToggleCollapsed={() => {}}
        onVisiblePositionChange={onVisiblePositionChange}
      />,
    );
    rerender(
      <CombatLogPanel
        events={[ev(1000, "a")]}
        collapsed
        onToggleCollapsed={() => {}}
        onVisiblePositionChange={onVisiblePositionChange}
      />,
    );
    expect(onVisiblePositionChange).toHaveBeenLastCalledWith(null);
  });
});
