import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { DpsLogSummary, DpsOverviewSegment } from "../../lib/api";
import {
  OVERVIEW_MAX_BARS,
  groupOverview,
  overviewGroupSecs,
  snapWindow,
} from "./dpsMeterShared";
import { PlaybackTimeline } from "./PlaybackTimeline";

function seg(start: number, damageOut = 0): DpsOverviewSegment {
  return { start, damageOut, damageIn: 0, mining: 0 };
}

describe("overviewGroupSecs", () => {
  it("picks the smallest 10^x-minute level that fits the strip", () => {
    // Up to OVERVIEW_MAX_BARS minutes → 1-minute bars.
    expect(overviewGroupSecs(60)).toBe(60);
    expect(overviewGroupSecs(OVERVIEW_MAX_BARS * 60)).toBe(60);
    // One more minute no longer fits → one power coarser.
    expect(overviewGroupSecs(OVERVIEW_MAX_BARS * 60 + 60)).toBe(600);
    // Ten times that → 100-minute bars.
    expect(overviewGroupSecs(OVERVIEW_MAX_BARS * 600 + 600)).toBe(6000);
  });

  it("never goes below the 1-minute floor", () => {
    expect(overviewGroupSecs(1)).toBe(60);
    expect(overviewGroupSecs(0)).toBe(60);
  });
});

describe("snapWindow", () => {
  it("snaps outward to whole group edges", () => {
    expect(snapWindow(65, 130, 60)).toEqual({ start: 60, end: 180 });
    expect(snapWindow(60, 120, 60)).toEqual({ start: 60, end: 120 });
    expect(snapWindow(610, 1190, 600)).toEqual({ start: 600, end: 1200 });
  });
});

describe("groupOverview", () => {
  it("sums segments into contiguous groups, idle groups stay zero", () => {
    const segments = [seg(60, 10), seg(120, 5), seg(600, 7)];
    const groups = groupOverview(segments, 0, 1200, 600);
    expect(groups.map((g) => g.start)).toEqual([0, 600]);
    expect(groups[0].damageOut).toBe(15);
    expect(groups[1].damageOut).toBe(7);
    // A window with no segments at all is still a full run of zero groups.
    const empty = groupOverview([], 0, 1800, 600);
    expect(empty.length).toBe(3);
    expect(empty.every((g) => g.damageOut === 0)).toBe(true);
  });

  it("ignores segments outside the window", () => {
    const groups = groupOverview([seg(0, 9), seg(600, 3)], 600, 1200, 600);
    expect(groups.length).toBe(1);
    expect(groups[0].damageOut).toBe(3);
  });
});

describe("PlaybackTimeline — segment grid (#985)", () => {
  const START = 1_785_672_000; // multiple of 600

  function summary(minutes: number): DpsLogSummary {
    return {
      start: START,
      end: START + minutes * 60,
      buckets: [],
      segments: Array.from({ length: minutes }, (_, i) =>
        seg(START + i * 60, i % 7),
      ),
    };
  }

  it("auto-fits the grouping level to the span", () => {
    const { unmount } = render(
      <PlaybackTimeline
        summary={summary(30)}
        position={null}
        region={null}
        onSeek={vi.fn()}
        onSelectRegion={vi.fn()}
        onClearRegion={vi.fn()}
      />,
    );
    expect(screen.getByText("1m/bar")).toBeInTheDocument();
    unmount();

    // 300 minutes don't fit at 1-minute bars (cap 160) → 10-minute bars.
    render(
      <PlaybackTimeline
        summary={summary(300)}
        position={null}
        region={null}
        onSeek={vi.fn()}
        onSelectRegion={vi.fn()}
        onClearRegion={vi.fn()}
      />,
    );
    expect(screen.getByText("10m/bar")).toBeInTheDocument();
  });

  it("snaps slider seeks to 1-minute segment edges", () => {
    const onSeek = vi.fn();
    render(
      <PlaybackTimeline
        summary={summary(30)}
        position={null}
        region={null}
        onSeek={onSeek}
        onSelectRegion={vi.fn()}
        onClearRegion={vi.fn()}
      />,
    );
    const slider = screen.getByRole("slider", { name: "Playback position" });
    const offGrid = START + 95; // mid-minute
    fireEvent.change(slider, { target: { value: String(offGrid) } });
    fireEvent.mouseUp(slider, { target: { value: String(offGrid) } });
    expect(onSeek).toHaveBeenCalledWith(START + 120);
  });

  it("widens a region by one segment per side, clamped to the log", () => {
    const onSelectRegion = vi.fn();
    render(
      <PlaybackTimeline
        summary={summary(30)}
        position={null}
        region={{ start: START + 300, end: START + 600 }}
        onSeek={vi.fn()}
        onSelectRegion={onSelectRegion}
        onClearRegion={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /\+1m/ }));
    expect(onSelectRegion).toHaveBeenCalledWith(START + 240, START + 660);
  });
});
