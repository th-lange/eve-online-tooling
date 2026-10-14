import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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
