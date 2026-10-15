import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { invokeMock, mockInvoke } from "../../test/harness";
import { RecordingProvider } from "./RecordingProvider";
import { useRecording } from "./recordingContext";

function TestButton() {
  const { runRecordingTest, recordingTestPhase } = useRecording();
  return (
    <button type="button" onClick={runRecordingTest}>
      Test recording {recordingTestPhase ?? "idle"}
    </button>
  );
}

describe("RecordingProvider — Test recording", () => {
  it("drives the enabled providers through start, post-roll, and stop", async () => {
    vi.useFakeTimers();
    try {
      localStorage.clear();
      localStorage.setItem(
        "pvp.fightRecording",
        JSON.stringify({
          enabled: true,
          postRollSecs: 10,
          hooks: {
            enabled: true,
            startCommand: "start-rec {start}",
            endCommand: "stop-rec",
          },
          obs: { enabled: true, url: "ws://test:4455", password: "" },
        }),
      );
      invokeMock.mockClear();
      mockInvoke({});
      render(
        <RecordingProvider>
          <TestButton />
        </RecordingProvider>,
      );

      fireEvent.click(screen.getByRole("button"));
      // Start actions fire immediately; the synthetic fight is now live.
      expect(invokeMock.mock.calls.map((c) => c[0])).toEqual([
        "recording_run_hook",
        "obs_fight_started",
      ]);
      screen.getByText(/recording/);

      // Clicking again mid-run is a no-op.
      fireEvent.click(screen.getByRole("button"));
      expect(invokeMock.mock.calls).toHaveLength(2);

      // 5 s fight → post-roll phase, nothing stopped yet.
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      screen.getByText(/post-roll/);
      expect(invokeMock.mock.calls).toHaveLength(2);

      // Post-roll elapses → end actions fire, phase resets.
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(invokeMock.mock.calls.map((c) => c[0])).toEqual([
        "recording_run_hook",
        "obs_fight_started",
        "recording_run_hook",
        "obs_fight_ended",
      ]);
      screen.getByText(/idle/);
    } finally {
      vi.useRealTimers();
    }
  });
});
