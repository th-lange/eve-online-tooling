import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { DpsPage } from "./DpsPage";
import type {
  DpsLogFile,
  DpsLogSummary,
  DpsPlaybackSettings,
  DpsTick,
} from "../../lib/api";

// DpsPage subscribes to live ticks via `listen`; capture the `dps://tick`
// callback so a test can push a tick and drive the current playback position.
let tickHandler: ((t: DpsTick) => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: DpsTick }) => void) => {
    if (name === "dps://tick") tickHandler = (t: DpsTick) => handler({ payload: t });
    return Promise.resolve(() => {});
  },
}));

function makeTick(at: number): DpsTick {
  const hq = { misses: 0, glances: 0, grazes: 0, hits: 0, penetrates: 0, smashes: 0, wrecks: 0 };
  return {
    at, windowSecs: 10, dpsOut: 50, dpsIn: 0, logiOut: 0, logiIn: 0,
    capWarfareOut: 0, capWarfareIn: 0, capTransferOut: 0, capTransferIn: 0,
    miningM3: 0, hitsOut: hq, hitsIn: hq, byWeapon: [], byPilot: [],
  };
}

// Same formatting the component uses — computed at runtime so assertions
// don't hardcode a timezone-dependent clock string.
function logDate(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function clock(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const OLDER_MTIME = 1_785_672_000;
const NEWER_MTIME = 1_786_005_000;

const LOGS: DpsLogFile[] = [
  {
    name: "20260801_120000_2112625622.txt",
    path: "/logs/20260801_120000_2112625622.txt",
    modified: OLDER_MTIME,
  },
  {
    name: "20260805_083000_2112625622.txt",
    path: "/logs/20260805_083000_2112625622.txt",
    modified: NEWER_MTIME,
  },
];

const SUMMARY_START = 1_785_672_000;
const SUMMARY_END = 1_785_672_600;
const SEEK_TS = 1_785_672_300;

const SUMMARY: DpsLogSummary = {
  start: SUMMARY_START,
  end: SUMMARY_END,
  buckets: Array.from({ length: 5 }, (_, i) => ({
    at: SUMMARY_START + i * 120,
    damageOut: i === 2 ? 1 : 0,
    damageIn: 0,
    mining: 0,
  })),
};

function renderInPlayback() {
  mockInvoke({
    dps_list_logs: () => LOGS,
    dps_log_summary: () => SUMMARY,
    dps_playback: () => undefined,
    eve_default_log_dir: () => "",
  });
  localStorage.setItem("eveGamelogsDir", "/EVE/logs/Gamelogs");
  const view = renderWithQuery(<DpsPage />);
  fireEvent.click(screen.getByRole("button", { name: "playback" }));
  return view;
}

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  tickHandler = undefined;
});

describe("DpsPage — playback file picker", () => {
  it("shows the selected file with its modified date, and filters as you type", async () => {
    renderInPlayback();

    // Auto-selects the first (newest) log; the field shows name + date.
    const input = await screen.findByPlaceholderText("search by filename…");
    await waitFor(() =>
      expect(input).toHaveValue(`${LOGS[0].name} — ${logDate(OLDER_MTIME)}`),
    );

    // Typing narrows the dropdown to matching filenames.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0805" } });
    expect(await screen.findByText(LOGS[1].name)).toBeInTheDocument();
    expect(screen.queryByText(LOGS[0].name)).not.toBeInTheDocument();

    // Each row shows its own date too.
    expect(screen.getByText(logDate(NEWER_MTIME))).toBeInTheDocument();

    // Picking a row updates the field to the picked file's label.
    fireEvent.click(screen.getByText(LOGS[1].name));
    await waitFor(() =>
      expect(input).toHaveValue(`${LOGS[1].name} — ${logDate(NEWER_MTIME)}`),
    );
  });
});

describe("DpsPage — playback timeline", () => {
  it("seeking parks the playhead without autoplaying; Play starts from there", async () => {
    renderInPlayback();

    // The scrubber renders once the summary loads (start/end clock labels).
    await screen.findByText("dmg out");
    expect(screen.getAllByText(clock(SUMMARY_START)).length).toBeGreaterThan(0);
    expect(screen.getByText(clock(SUMMARY_END))).toBeInTheDocument();

    // Dragging the slider and releasing only parks the playhead — it must NOT
    // start playback (scrolling to a time no longer autoplays).
    const slider = screen.getByRole("slider", { name: "Playback position" });
    fireEvent.change(slider, { target: { value: String(SEEK_TS) } });
    fireEvent.mouseUp(slider, { target: { value: String(SEEK_TS) } });
    expect(
      invokeMock.mock.calls.find(([cmd]) => cmd === "dps_playback"),
    ).toBeUndefined();

    // Play starts playback from the parked position.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => {
      const call = [...invokeMock.mock.calls]
        .reverse()
        .find(([cmd]) => cmd === "dps_playback");
      expect(call).toBeDefined();
      const args = call?.[1] as { settings: DpsPlaybackSettings };
      expect(args.settings.seekTs).toBe(SEEK_TS);
      expect(args.settings.file).toBe(LOGS[0].path);
    });
  });

  it("rounds a fractional parked seek to an integer i64 when playback starts", async () => {
    renderInPlayback();
    await screen.findByText("dmg out");

    // A fractional timestamp (as the slider can emit) must not reach the
    // backend verbatim — Rust's `seek_ts: i64` rejects floats.
    const slider = screen.getByRole("slider", { name: "Playback position" });
    const fractional = SUMMARY_START + 123.565;
    fireEvent.change(slider, { target: { value: String(fractional) } });
    fireEvent.mouseUp(slider, { target: { value: String(fractional) } });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => {
      const call = [...invokeMock.mock.calls]
        .reverse()
        .find(([cmd]) => cmd === "dps_playback");
      const args = call?.[1] as { settings: DpsPlaybackSettings };
      expect(args.settings.seekTs).toBe(Math.round(fractional));
      expect(Number.isInteger(args.settings.seekTs)).toBe(true);
    });
  });

  it("stop then play resumes from where it stopped, not the log start", async () => {
    renderInPlayback();
    await screen.findByText("dmg out");

    // Start playback from the top.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await screen.findByRole("button", { name: "Stop" });

    // A tick advances the playhead to a mid-log position.
    const pos = SUMMARY_START + 200;
    act(() => tickHandler?.(makeTick(pos)));

    // Stop, then Play again — playback must resume at `pos`, not restart at 0.
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(await screen.findByRole("button", { name: "Play" }));

    await waitFor(() => {
      const call = [...invokeMock.mock.calls]
        .reverse()
        .find(([cmd]) => cmd === "dps_playback");
      const args = call?.[1] as { settings: DpsPlaybackSettings };
      expect(args.settings.seekTs).toBe(pos);
    });
  });
});
