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
 *  `groupHeight`-tall bucket groups stacked in time order inside a
 *  `clientHeight`-tall viewport, scrolled to `scrollTop`. */
function stubGeometry(
  el: HTMLElement,
  {
    scrollTop,
    scrollHeight,
    clientHeight,
    groupHeight = 120,
  }: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    groupHeight?: number;
  },
) {
  Object.defineProperty(el, "scrollTop", {
    value: scrollTop,
    writable: true,
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
    if ((child as HTMLElement).dataset.bucket === undefined) continue;
    Object.defineProperty(child, "offsetTop", {
      value: i * groupHeight,
      configurable: true,
    });
    Object.defineProperty(child, "offsetHeight", {
      value: groupHeight,
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
  it("reports the centre group's minute and pauses auto-scroll when scrolled away from the bottom", async () => {
    vi.useFakeTimers();
    try {
      // ts 3600–3609 → two bucket groups: 3600 and 3605, both in minute 3600.
      const events = Array.from({ length: 10 }, (_, i) =>
        ev(3600 + i, `p${i}`),
      );
      const onVisibleCenterChange = vi.fn();
      const { container } = render(
        <CombatLogPanel
          events={events}
          collapsed={false}
          onToggleCollapsed={() => {}}
          onVisibleCenterChange={onVisibleCenterChange}
        />,
      );
      const list = container.querySelector(".overflow-y-auto") as HTMLElement;
      // Let the mount-triggered auto-scroll's "this is a programmatic scroll,
      // ignore it" grace window elapse before simulating a real user scroll.
      await act(() => vi.advanceTimersByTimeAsync(650));

      // Two 120px groups (240px content) in a 50px viewport, scrolled to
      // 130px: viewport centre = 155px → group 3605 (centre 180) is closest;
      // the report is its MINUTE (3600), the shared cursor id.
      stubGeometry(list, {
        scrollTop: 130,
        scrollHeight: 240,
        clientHeight: 50,
      });
      await scrollAndFlush(list);

      expect(onVisibleCenterChange).toHaveBeenCalledWith(3600);
      expect(
        screen.getByRole("checkbox", { name: "Auto-scroll" }),
      ).not.toBeChecked();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tints every group inside the cursor's minute", () => {
    // Groups 3540 and 3600 sit in different minutes.
    const events = [ev(3541, "a"), ev(3601, "b")];
    const { container } = render(
      <CombatLogPanel
        events={events}
        collapsed={false}
        onToggleCollapsed={() => {}}
        cursor={3600}
      />,
    );
    const groups = container.querySelectorAll("[data-bucket]");
    expect(groups).toHaveLength(2);
    expect((groups[1] as HTMLElement).className).toContain("bg-indigo-500/10");
    expect((groups[0] as HTMLElement).className).not.toContain(
      "bg-indigo-500/10",
    );
  });

  it("re-reports the centre when content changes while scrolled up (no stale cursor)", async () => {
    vi.useFakeTimers();
    try {
      const events = Array.from({ length: 10 }, (_, i) =>
        ev(3600 + i, `p${i}`),
      );
      const onVisibleCenterChange = vi.fn();
      const { container, rerender } = render(
        <CombatLogPanel
          events={events}
          collapsed={false}
          onToggleCollapsed={() => {}}
          onVisibleCenterChange={onVisibleCenterChange}
        />,
      );
      const list = container.querySelector(".overflow-y-auto") as HTMLElement;
      await act(() => vi.advanceTimersByTimeAsync(650));
      stubGeometry(list, {
        scrollTop: 130,
        scrollHeight: 240,
        clientHeight: 50,
      });
      await scrollAndFlush(list);
      const callsAfterScroll = onVisibleCenterChange.mock.calls.length;
      expect(callsAfterScroll).toBeGreaterThan(0);

      // New lines arrive while scrolled into history: the content shifts
      // under the fixed scroll position, so the centre MUST be re-reported
      // without any further scroll event.
      await act(async () => {
        rerender(
          <CombatLogPanel
            events={[...events, ev(3620, "later")]}
            collapsed={false}
            onToggleCollapsed={() => {}}
            onVisibleCenterChange={onVisibleCenterChange}
          />,
        );
      });
      expect(onVisibleCenterChange.mock.calls.length).toBeGreaterThan(
        callsAfterScroll,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("centres the jumped-to bucket's group by scrolling the container only", () => {
    const events = [ev(1000, "a"), ev(1006, "b")];
    const { container, rerender } = render(
      <CombatLogPanel
        events={events}
        collapsed={false}
        onToggleCollapsed={() => {}}
      />,
    );
    const list = container.querySelector(".overflow-y-auto") as HTMLElement;
    // Two 120px groups in a 50px viewport (geometry stubbed — jsdom has no
    // layout), then the jump request arrives.
    stubGeometry(list, { scrollTop: 0, scrollHeight: 240, clientHeight: 50 });
    rerender(
      <CombatLogPanel
        events={events}
        collapsed={false}
        onToggleCollapsed={() => {}}
        jumpTo={{ start: 1005, n: 1 }}
      />,
    );
    // Group 1005 sits at 120px, 120px tall → centred: 120 - (50-120)/2 = 155.
    // Only the log container scrolled — the page/window is untouched
    // (scrollIntoView would have scrolled every ancestor).
    expect(list.scrollTop).toBe(155);
  });

  it("clears the marker and re-enables auto-scroll once scrolled back to the bottom", async () => {
    vi.useFakeTimers();
    try {
      const events = Array.from({ length: 10 }, (_, i) =>
        ev(1000 + i, `p${i}`),
      );
      const onVisibleCenterChange = vi.fn();
      const { container } = render(
        <CombatLogPanel
          events={events}
          collapsed={false}
          onToggleCollapsed={() => {}}
          onVisibleCenterChange={onVisibleCenterChange}
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

      expect(onVisibleCenterChange).toHaveBeenLastCalledWith(null);
      expect(
        screen.getByRole("checkbox", { name: "Auto-scroll" }),
      ).toBeChecked();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the marker when the panel is collapsed", () => {
    const onVisibleCenterChange = vi.fn();
    const { rerender } = render(
      <CombatLogPanel
        events={[ev(1000, "a")]}
        collapsed={false}
        onToggleCollapsed={() => {}}
        onVisibleCenterChange={onVisibleCenterChange}
      />,
    );
    rerender(
      <CombatLogPanel
        events={[ev(1000, "a")]}
        collapsed
        onToggleCollapsed={() => {}}
        onVisibleCenterChange={onVisibleCenterChange}
      />,
    );
    expect(onVisibleCenterChange).toHaveBeenLastCalledWith(null);
  });
});
