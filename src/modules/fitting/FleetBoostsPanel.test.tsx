import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FleetBoost } from "../../lib/api";
import { FleetBoostsPanel } from "./FleetBoostsPanel";

const state = vi.hoisted(() => ({
  boosts: [] as FleetBoost[],
  onAdd: vi.fn(),
}));

vi.mock("./useFitEditorContext", () => ({
  useFitState: () => ({
    fleetBoosts: state.boosts,
    addFleetBoost: state.onAdd,
    removeFleetBoost: vi.fn(),
  }),
  useFitStats: () => ({
    nameOf: (id: number) => `#${id}`,
    stats: {
      data: {
        fleetBuffsApplied: [
          {
            buffId: 20,
            label: "Evasive Maneuvers: signature radius",
            valuePct: -11.25,
          },
        ],
      },
    },
  }),
}));

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <FleetBoostsPanel />
    </QueryClientProvider>,
  );
}

describe("FleetBoostsPanel", () => {
  it("shows the applied buff values after the per-buff merge", () => {
    state.boosts = [
      {
        kind: "genericLink",
        linkType: "skirmishEvasiveManeuvers",
        strengthPct: 5,
        mindlink: true,
      },
    ];
    renderPanel();
    expect(
      screen.getByText("Skirmish: Evasive Maneuvers (5%/lvl, mindlink)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Evasive Maneuvers: signature radius"),
    ).toBeInTheDocument();
    expect(screen.getByText("-11.25%")).toBeInTheDocument();
  });

  it("adds a generic link with the chosen strength and mindlink", () => {
    state.boosts = [];
    state.onAdd.mockClear();
    renderPanel();
    fireEvent.click(screen.getByText("Add"));
    fireEvent.change(screen.getByLabelText("Burst link"), {
      target: { value: "shieldHarmonizing" },
    });
    fireEvent.change(screen.getByLabelText("Ship bonus %/lvl"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByLabelText("Mindlink"));
    fireEvent.click(screen.getByText("Add boost"));
    expect(state.onAdd).toHaveBeenCalledWith({
      kind: "genericLink",
      linkType: "shieldHarmonizing",
      strengthPct: 3,
      mindlink: true,
    });
  });
});
