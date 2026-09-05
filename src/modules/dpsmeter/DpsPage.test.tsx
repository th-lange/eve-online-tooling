import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { DpsPage } from "./DpsPage";
import type {
  DpsLogFile,
  DpsLogSummary,
  DpsPlaybackSettings,
} from "../../lib/api";

// DpsPage subscribes to live ticks via `listen`; capture the callback so
// tests could push one if needed (unused here — these tests exercise the
// playback-mode file picker and timeline, not the live tick feed).
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

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
  it("loads the activity summary and seeking restarts playback with seekTs", async () => {
    renderInPlayback();

    // The scrubber renders once the summary loads (start/end clock labels).
    await screen.findByText("dmg out");
    // (`clock(SUMMARY_START)` also doubles as the idle position readout
    // below the slider, since it defaults to `start` before any tick.)
    expect(screen.getAllByText(clock(SUMMARY_START)).length).toBeGreaterThan(0);
    expect(screen.getByText(clock(SUMMARY_END))).toBeInTheDocument();

    // Dragging the slider and releasing seeks: dps_playback is called again
    // with seekTs set to the released value, not the file's start.
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: String(SEEK_TS) } });
    fireEvent.mouseUp(slider, { target: { value: String(SEEK_TS) } });

    await waitFor(() => {
      const call = invokeMock.mock.calls.find(
        ([cmd]) => cmd === "dps_playback",
      );
      expect(call).toBeDefined();
      // The mock's args are untyped (`unknown[]`) — assert the one shape
      // `dpsPlayback` ever sends, named so the assertions below read a
      // fully-typed value rather than an inline cast on a member access.
      const args = call?.[1] as { settings: DpsPlaybackSettings };
      expect(args.settings.seekTs).toBe(SEEK_TS);
      expect(args.settings.file).toBe(LOGS[0].path);
    });
  });
});
