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
  it("reports the centre group's bucket start and pauses auto-scroll when scrolled away from the bottom", async () => {
    vi.useFakeTimers();
    try {
      // ts 1000–1009 → two bucket groups: 1000 (1000–1004) and 1005 (1005–1009).
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
      // Let the mount-triggered auto-scroll's "this is a programmatic scroll,
      // ignore it" grace window elapse before simulating a real user scroll.
      await act(() => vi.advanceTimersByTimeAsync(650));

      // Two 120px groups (240px content) in a 50px viewport, scrolled to
      // 130px: viewport centre = 155px → group 1005 (centre 180) is closest.
      stubGeometry(list, {
        scrollTop: 130,
        scrollHeight: 240,
        clientHeight: 50,
      });
      await scrollAndFlush(list);

      expect(onVisibleCenterChange).toHaveBeenCalledWith(1005);
      expect(
        screen.getByRole("checkbox", { name: "Auto-scroll" }),
      ).not.toBeChecked();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tints the group the shared cursor names and draws bucket dividers", () => {
    const events = [ev(1000, "a"), ev(1006, "b")];
    const { container } = render(
      <CombatLogPanel
        events={events}
        collapsed={false}
        onToggleCollapsed={() => {}}
        cursor={1005}
      />,
    );
    const groups = container.querySelectorAll("[data-bucket]");
    expect(groups).toHaveLength(2);
    expect((groups[1] as HTMLElement).className).toContain("bg-indigo-500/10");
    expect((groups[0] as HTMLElement).className).not.toContain(
      "bg-indigo-500/10",
    );
  });

  it("scrolls the jumped-to bucket's group into view (chart → log)", () => {
    const events = [ev(1000, "a"), ev(1006, "b")];
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      render(
        <CombatLogPanel
          events={events}
          collapsed={false}
          onToggleCollapsed={() => {}}
          jumpTo={{ start: 1005, n: 1 }}
        />,
      );
      // The jump effect centres the 1005 group (the mount auto-scroll also
      // calls scrollIntoView on the bottom anchor — look for the centred one).
      expect(scrollSpy).toHaveBeenCalledWith({
        block: "center",
        behavior: "smooth",
      });
      const centred = scrollSpy.mock.contexts.find(
        (el) => (el as unknown as HTMLElement).dataset?.bucket === "1005",
      );
      expect(centred).toBeTruthy();
    } finally {
      scrollSpy.mockRestore();
    }
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
