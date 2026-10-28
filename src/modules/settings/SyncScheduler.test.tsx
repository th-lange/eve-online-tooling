import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

const syncNowMock = vi.fn();
vi.mock("../../lib/sync/syncNow", () => ({
  syncNow: (...a: unknown[]) => syncNowMock(...a),
}));

import { SyncScheduler } from "./SyncScheduler";
import { touch } from "../../lib/sync/manifest";
import {
  SYNC_CHANGE_DEBOUNCE_MS,
  SYNC_POLL_INTERVAL_MS,
} from "../../lib/refreshIntervals";

function activate() {
  localStorage.setItem("sync.folder", JSON.stringify("/shared/sync"));
  localStorage.setItem("sync.enabled", JSON.stringify(true));
}

beforeEach(() => {
  localStorage.clear();
  syncNowMock.mockReset();
  syncNowMock.mockResolvedValue({ imported: [], exported: [], unchanged: [] });
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("SyncScheduler", () => {
  it("does nothing when sync isn't active", async () => {
    render(<SyncScheduler />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    act(() => touch("reminders"));
    await act(
      async () =>
        void (await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)),
    );
    expect(syncNowMock).not.toHaveBeenCalled();
  });

  it("syncs on mount, debounced on change, and periodically when active", async () => {
    activate();
    render(<SyncScheduler />);

    // Startup catch-up.
    expect(syncNowMock).toHaveBeenCalledTimes(1);
    expect(syncNowMock).toHaveBeenCalledWith("/shared/sync");
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));

    // A local change debounces into exactly one sync.
    act(() => touch("reminders"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(syncNowMock).toHaveBeenCalledTimes(1); // not yet (still in debounce)
    await act(
      async () =>
        void (await vi.advanceTimersByTimeAsync(SYNC_CHANGE_DEBOUNCE_MS)),
    );
    expect(syncNowMock).toHaveBeenCalledTimes(2);

    // The periodic tick keeps pulling.
    await act(
      async () =>
        void (await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)),
    );
    expect(syncNowMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
