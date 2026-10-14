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

  it("pauses auto-scroll away from the bottom and resumes at the bottom", async () => {
    vi.useFakeTimers();
    try {
      const events = Array.from({ length: 10 }, (_, i) =>
        ev(3600 + i, `p${i}`),
      );
      const { container } = render(
        <CombatLogPanel
          events={events}
          collapsed={false}
          onToggleCollapsed={() => {}}
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

      // Scrolled to the very bottom (150px = 200 - 50): auto-scroll resumes.
      stubGeometry(list, {
        scrollTop: 150,
        scrollHeight: 200,
        clientHeight: 50,
      });
      await scrollAndFlush(list);
      expect(
        screen.getByRole("checkbox", { name: "Auto-scroll" }),
      ).toBeChecked();
    } finally {
      vi.useRealTimers();
    }
  });
});
