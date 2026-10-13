import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { mockInvoke, renderWithQuery } from "../../test/harness";
import { FightOverlayProvider } from "./FightOverlayProvider";
import { useFightOverlay } from "./fightOverlayContext";

// jsdom has no audio playback — the Test button's staggered cue clips call
// it (scrollIntoView is stubbed globally in src/test/setup.ts).
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);

// A minimal consumer that exposes the same "Test" trigger SettingsPage wires
// up, without pulling in the rest of that page's unrelated settings/queries.
function TestTrigger() {
  const { runTest } = useFightOverlay();
  return (
    <button type="button" onClick={runTest}>
      Run Test
    </button>
  );
}

describe("FightOverlayProvider — combat log", () => {
  it("renders the sample fight's combat log once expanded", () => {
    localStorage.clear();
    mockInvoke({ pvp_profiles: () => ({ pilots: [], unresolved: [] }) });
    renderWithQuery(
      <FightOverlayProvider>
        <TestTrigger />
      </FightOverlayProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run Test" }));

    // Defaults collapsed in the overlay (it's already a dense 3-column
    // popup) — expand it before asserting on its contents.
    const toggle = screen.getByRole("button", { name: /Combat log/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    // The sample fight's outgoing hits from John Doe (one per tick, so
    // several identical lines repeat — any match proves the wiring).
    expect(
      screen.getAllByText(/dmg → John Doe \(Kestrel\)/).length,
    ).toBeGreaterThan(0);
    // The scripted scram/point pair, which exercise the non-damage line kinds.
    expect(screen.getByText(/Scrambled ← Jane Doe/)).toBeVisible();
    expect(screen.getByText(/Pointed → John Doe/)).toBeVisible();
  });
});

describe("FightOverlayProvider — combat log position marker", () => {
  it("draws a marker on the mini DPS chart once the log is scrolled away from the bottom", async () => {
    localStorage.clear();
    mockInvoke({ pvp_profiles: () => ({ pilots: [], unresolved: [] }) });
    renderWithQuery(
      <FightOverlayProvider>
        <TestTrigger />
      </FightOverlayProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run Test" }));
    fireEvent.click(screen.getByRole("button", { name: /Combat log/ }));

    // The fight panel is a `Modal`, portalled to `document.body` rather than
    // `container` — query the document, not the render container. The
    // 3-column grid above the log also has `overflow-y-auto`, so take the
    // last match: the combat log's own scroll container, rendered after it.
    const lists = document.querySelectorAll(".overflow-y-auto");
    const list = lists[lists.length - 1] as HTMLElement;
    expect(list).toBeTruthy();
    // No marker yet — the log opened auto-scrolled to its live tail.
    expect(
      document.querySelector('svg rect[fill="#818cf8"]'),
    ).not.toBeInTheDocument();

    // Real time throughout: the panel's own mount-triggered auto-scroll
    // schedules a real `setTimeout` to clear its "ignore this scroll, it's
    // programmatic" flag, which fake timers can't reach in after the fact —
    // and switching to fake timers *before* the clicks above stalls React's
    // own scheduler mid-render. A real, if slower, wait sidesteps both.
    await act(() => new Promise((r) => setTimeout(r, 650)));

    Object.defineProperty(list, "scrollTop", {
      value: 10,
      configurable: true,
    });
    Object.defineProperty(list, "scrollHeight", {
      value: 500,
      configurable: true,
    });
    Object.defineProperty(list, "clientHeight", {
      value: 100,
      configurable: true,
    });
    let i = 0;
    for (const child of list.children) {
      if ((child as HTMLElement).dataset.ts === undefined) continue;
      Object.defineProperty(child, "offsetTop", {
        value: i * 20,
        configurable: true,
      });
      Object.defineProperty(child, "offsetHeight", {
        value: 20,
        configurable: true,
      });
      i++;
    }
    await act(async () => {
      fireEvent.scroll(list);
      await new Promise((r) => requestAnimationFrame(r));
    });

    expect(
      document.querySelector('svg rect[fill="#818cf8"]'),
    ).toBeInTheDocument();
  });
});
