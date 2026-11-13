import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { invokeMock, mockInvoke } from "../../test/harness";
import type { Fit, FitStats } from "../../lib/api";
import type { FitStateSlice } from "./useFitCoreState";
import { useFitCoreStats } from "./useFitCoreStats";

const STATS = { resources: {}, validation: [] } as unknown as FitStats;

function fitWith(shipTypeId: number, quantity: number): Fit {
  return {
    id: "f",
    name: "f",
    shipTypeId,
    items: [{ typeId: 1, slot: "cargo", index: 0, state: "online", quantity }],
  };
}

function stateFor(fit: Fit | null): FitStateSlice {
  return {
    fit,
    skillSource: "allFive",
    neutGjs: undefined,
    targetProfile: undefined,
    fleetBoosts: [],
    environmentEffect: null,
    abyssalWeather: null,
    spoolPct: undefined,
    factorReload: false,
    jammed: false,
  } as unknown as FitStateSlice;
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const simulateCalls = () =>
  invokeMock.mock.calls.filter(([cmd]) => cmd === "fitting_simulate");

describe("useFitCoreStats simulate query", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    mockInvoke({ fitting_simulate: () => STATS });
  });

  it("runs one simulation for a burst of edits and keeps the old stats meanwhile", async () => {
    const { result, rerender } = renderHook(
      ({ fit }: { fit: Fit }) => useFitCoreStats(stateFor(fit)),
      { wrapper, initialProps: { fit: fitWith(587, 1) } },
    );
    await waitFor(() => expect(result.current.stats.data).toBeDefined());
    expect(simulateCalls()).toHaveLength(1);

    // A slider drag: many rapid edits to the same hull.
    for (let q = 2; q <= 6; q++) {
      act(() => rerender({ fit: fitWith(587, q) }));
    }
    // Still the previous result on screen, not blanked, and nothing re-run yet.
    expect(result.current.stats.data).toBe(STATS);
    expect(simulateCalls()).toHaveLength(1);

    await waitFor(() => expect(simulateCalls()).toHaveLength(2));
    expect(simulateCalls()[1]![1]).toMatchObject({
      fit: fitWith(587, 6),
    });
  });

  it("does not show another hull's stats while the new hull computes", async () => {
    const { result, rerender } = renderHook(
      ({ fit }: { fit: Fit }) => useFitCoreStats(stateFor(fit)),
      { wrapper, initialProps: { fit: fitWith(587, 1) } },
    );
    await waitFor(() => expect(result.current.stats.data).toBeDefined());
    mockInvoke({ fitting_simulate: () => new Promise(() => {}) });
    rerender({ fit: fitWith(588, 1) });
    await waitFor(() => expect(simulateCalls()).toHaveLength(2));
    expect(result.current.stats.data).toBeUndefined();
  });
});
