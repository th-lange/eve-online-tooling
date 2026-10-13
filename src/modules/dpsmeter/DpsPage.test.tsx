import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { DpsPage } from "./DpsPage";
import type {
  DpsBucket,
  DpsLogFile,
  DpsLogSummary,
  DpsPlaybackSettings,
} from "../../lib/api";

// DpsPage subscribes to the 5 s buckets via `listen` (the log rides inside
// them, #1000); capture the callback so a test can push payloads directly.
let bucketsHandler: ((buckets: DpsBucket[]) => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: DpsBucket[] }) => void) => {
    if (name === "dps://buckets")
      bucketsHandler = (buckets: DpsBucket[]) => handler({ payload: buckets });
    return Promise.resolve(() => {});
  },
}));

const hq = {
  misses: 0,
  glances: 0,
  grazes: 0,
  hits: 0,
  penetrates: 0,
  smashes: 0,
  wrecks: 0,
};

/** A finalized 5 s bucket starting at `start` (end = start + 5). */
function makeBucket(start: number, damageOut = 100): DpsBucket {
  return {
    start,
    end: start + 5,
    damageOut,
    damageIn: 0,
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
  // Fixed 1-minute segments over the same 600s span (SUMMARY_START is a
  // multiple of 60, so the grid starts exactly there).
  segments: Array.from({ length: 10 }, (_, i) => ({
    start: SUMMARY_START + i * 60,
    damageOut: i === 5 ? 1000 : 0,
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
  bucketsHandler = undefined;
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

  it("snaps a parked seek to the nearest 1-minute segment edge (#985)", async () => {
    renderInPlayback();
    await screen.findByText("dmg out");

    // A fractional, off-grid timestamp (as the slider can emit) must reach
    // the backend as a whole-minute segment edge — Rust's `seek_ts: i64`
    // rejects floats, and #985 pins seeks to the segment grid.
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
      expect(args.settings.seekTs).toBe(SUMMARY_START + 120);
      expect((args.settings.seekTs ?? 0) % 60).toBe(0);
    });
  });

  it("stop then play resumes from where it stopped, not the log start", async () => {
    renderInPlayback();
    await screen.findByText("dmg out");

    // Start playback from the top.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await screen.findByRole("button", { name: "Stop" });

    // A finalized bucket advances the playhead to its end — a mid-log
    // position (`pos` is a multiple of 5, so it's a valid bucket end).
    const pos = SUMMARY_START + 200;
    act(() => bucketsHandler?.([makeBucket(pos - 5)]));

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

  it("rebuilds the overview only when the growing log changes size", async () => {
    vi.useFakeTimers();
    try {
      let size = 100;
      mockInvoke({
        dps_list_logs: () => LOGS,
        dps_log_summary: () => SUMMARY,
        dps_log_stat: () => size,
        dps_playback: () => undefined,
        eve_default_log_dir: () => "",
      });
      localStorage.setItem("eveGamelogsDir", "/EVE/logs/Gamelogs");
      renderWithQuery(<DpsPage />);
      fireEvent.click(screen.getByRole("button", { name: "playback" }));
      // Flush the async file-select + initial summary/stat load under fake timers.
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);

      const summaryCalls = () =>
        invokeMock.mock.calls.filter(([c]) => c === "dps_log_summary").length;
      const base = summaryCalls();
      expect(base).toBeGreaterThan(0);

      // Unchanged size → a 30 s poll must NOT rebuild the overview.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(summaryCalls()).toBe(base);

      // The log grew → the next poll rebuilds it exactly once.
      size = 200;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(summaryCalls()).toBe(base + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DpsPage — combat log", () => {
  it("renders the log lines carried inside a dps://buckets payload", async () => {
    mockInvoke({});
    renderWithQuery(<DpsPage />);

    // The subscription is live as soon as the page mounts — no Start needed.
    // The log renders from the buckets' own events (#1000): one source for
    // chart and log, so a segment and its lines can never drift apart.
    await waitFor(() => expect(bucketsHandler).toBeDefined());
    const b = makeBucket(1_700_000_000, 450);
    b.events = [
      {
        ts: 1_700_000_000,
        kind: "damageOut",
        amount: 450,
        pilot: "Target Pilot",
        ship: "Cruiser",
        weapon: "Dual Giga Pulse Laser II",
        quality: "Wrecks",
        ore: null,
        volume: 0,
      },
    ];
    act(() => bucketsHandler!([b]));

    expect(
      await screen.findByText(
        /450 dmg → Target Pilot \(Cruiser\) — Dual Giga Pulse Laser II \[Wrecks\]/,
      ),
    ).toBeInTheDocument();

    // Collapsing hides the lines without losing them — expanding again shows
    // the same event, proving the buffer lives above the panel, not inside it.
    fireEvent.click(screen.getByRole("button", { name: /Combat log/ }));
    expect(screen.queryByText(/Target Pilot/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Combat log/ }));
    expect(screen.getByText(/Target Pilot/)).toBeInTheDocument();
  });
});

describe("DpsPage — 5s bucket time grid (#983)", () => {
  it("renders buckets pushed over dps://buckets on the fixed time grid", async () => {
    mockInvoke({});
    renderWithQuery(<DpsPage />);

    await waitFor(() => expect(bucketsHandler).toBeDefined());
    // Before any bucket arrives, the grid is waiting.
    expect(screen.getAllByText(/Waiting for the first 5s bucket/).length).toBe(
      2,
    );

    act(() =>
      bucketsHandler!([makeBucket(1000), makeBucket(1005), makeBucket(1010)]),
    );

    expect(
      screen.queryByText(/Waiting for the first 5s bucket/),
    ).not.toBeInTheDocument();
    // Both panels (Outgoing + Incoming, default side layout) show the grid,
    // and the out chart's peak reads the bucket rate (100 hp / 5 s = 20/s).
    expect(screen.getAllByText(/5s grid/).length).toBe(2);
    expect(screen.getByText("peak 20")).toBeInTheDocument();
  });
});
