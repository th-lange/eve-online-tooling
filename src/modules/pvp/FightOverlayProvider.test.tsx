import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { FightOverlayProvider } from "./FightOverlayProvider";
import { useFightOverlay } from "./fightOverlayContext";
import { RecordingProvider } from "../recording/RecordingProvider";
import { useRecording } from "../recording/recordingContext";
import type { DpsBucket } from "../../lib/api";

// The overlay subscribes to dps://buckets via `listen`; capture the callback
// so tests can push fight buckets directly.
let bucketsHandler: ((buckets: DpsBucket[]) => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: DpsBucket[] }) => void) => {
    if (name === "dps://buckets")
      bucketsHandler = (buckets) => handler({ payload: buckets });
    return Promise.resolve(() => {});
  },
}));

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

// Consumer flipping the recording master switch off, like SettingsPage does.
function DisableRecording() {
  const { recording, setRecording } = useRecording();
  return (
    <button
      type="button"
      onClick={() => setRecording({ ...recording, enabled: false })}
    >
      Disable rec
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

const hq = {
  misses: 0,
  glances: 0,
  grazes: 0,
  hits: 0,
  penetrates: 0,
  smashes: 0,
  wrecks: 0,
};

function bucket(start: number, damageIn = 0): DpsBucket {
  return {
    start,
    end: start + 5,
    damageOut: 0,
    damageIn,
    repOut: 0,
    repIn: 0,
    capTransferOut: 0,
    capTransferIn: 0,
    capWarfareOut: 0,
    capWarfareIn: 0,
    miningM3: 0,
    hitsOut: hq,
    hitsIn: hq,
    byWeapon: [],
    byPilot: [],
    events: [],
  };
}

/** Commands passed to recording_run_hook so far, in order. */
function hookCalls(): string[] {
  return invokeMock.mock.calls
    .filter((c) => c[0] === "recording_run_hook")
    .map((c) => (c[1] as { command: string }).command);
}

describe("FightOverlayProvider — recording hooks (#1014)", () => {
  it("runs the start hook on fight start and the end hook after the post-roll", async () => {
    vi.useFakeTimers();
    try {
      localStorage.clear();
      localStorage.setItem("pvp.fightScan", "true");
      localStorage.setItem(
        "pvp.fightRecording",
        JSON.stringify({
          enabled: true,
          startCommand: "start-rec {start}",
          endCommand: "stop-rec {start} {end}",
          postRollSecs: 10,
          obsEnabled: true,
          obsUrl: "ws://test:4455",
          obsPassword: "pw",
        }),
      );
      bucketsHandler = undefined;
      invokeMock.mockClear();
      mockInvoke({
        pvp_profiles: () => ({ pilots: [], unresolved: [] }),
        obs_fight_ended: () => "/tmp/fight.mkv",
      });
      renderWithQuery(
        <RecordingProvider>
          <FightOverlayProvider>
            <div />
          </FightOverlayProvider>
        </RecordingProvider>,
      );
      // Flush the async listen subscription.
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(bucketsHandler).toBeDefined();

      // Combat bucket → fight starts → start hook with {start} filled.
      act(() => bucketsHandler!([bucket(1000, 50)]));
      expect(hookCalls()).toEqual(["start-rec 1000"]);

      // One empty bucket freezes the fight — but the end hook waits for the
      // post-roll so the clip keeps the aftermath.
      act(() => bucketsHandler!([bucket(1005)]));
      expect(hookCalls()).toEqual(["start-rec 1000"]);
      await act(() => vi.advanceTimersByTimeAsync(9_000));
      expect(hookCalls()).toEqual(["start-rec 1000"]);
      await act(() => vi.advanceTimersByTimeAsync(1_100));
      expect(hookCalls()).toEqual(["start-rec 1000", "stop-rec 1000 1010"]);

      // The OBS path fired alongside the hooks with the configured settings.
      const obsCalls = invokeMock.mock.calls
        .filter((c) => String(c[0]).startsWith("obs_"))
        .map((c) => c[0]);
      expect(obsCalls).toEqual(["obs_fight_started", "obs_fight_ended"]);
      expect(
        invokeMock.mock.calls.find((c) => c[0] === "obs_fight_started")?.[1],
      ).toEqual({ settings: { url: "ws://test:4455", password: "pw" } });

      // OBS reported a clip path → the fight sidecar is written next to it
      // with the span and totals from the frozen buffer (#1016).
      await act(() => vi.advanceTimersByTimeAsync(0)); // flush the .then chain
      const sidecar = invokeMock.mock.calls.find(
        (c) => c[0] === "recording_write_sidecar",
      )?.[1] as { clipPath: string; meta: Record<string, unknown> };
      expect(sidecar.clipPath).toBe("/tmp/fight.mkv");
      expect(sidecar.meta).toMatchObject({
        start: 1000,
        end: 1010,
        damageIn: 50,
        damageOut: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops immediately (no post-roll) when recording is disabled mid-fight", async () => {
    vi.useFakeTimers();
    try {
      localStorage.clear();
      localStorage.setItem("pvp.fightScan", "true");
      localStorage.setItem(
        "pvp.fightRecording",
        JSON.stringify({
          enabled: true,
          startCommand: "start-rec",
          endCommand: "stop-rec",
          postRollSecs: 60,
        }),
      );
      bucketsHandler = undefined;
      invokeMock.mockClear();
      mockInvoke({ pvp_profiles: () => ({ pilots: [], unresolved: [] }) });
      renderWithQuery(
        <RecordingProvider>
          <FightOverlayProvider>
            <DisableRecording />
          </FightOverlayProvider>
        </RecordingProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));

      act(() => bucketsHandler!([bucket(0, 10)]));
      expect(hookCalls()).toEqual(["start-rec"]);

      // Mid-fight off switch: the end hook must fire right away, not after
      // the 60 s post-roll.
      fireEvent.click(screen.getByRole("button", { name: "Disable rec" }));
      expect(hookCalls()).toEqual(["start-rec", "stop-rec"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
