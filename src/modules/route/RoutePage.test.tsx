import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { AppError, SystemActivity } from "../../lib/api";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";

import { RoutePage } from "./RoutePage";

const SDE_OK = { installed: true, path: "/sde", sizeBytes: 1, updated: false };

const SYSTEM: SystemActivity = {
  systemId: 30000142,
  name: "Jita",
  region: "The Forge",
  security: 0.9,
  jumps: 1200,
  shipKills: 3,
  podKills: 1,
  npcKills: 40,
};

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
});

describe("RoutePage", () => {
  it("renders per-system activity", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      route_system_activity: () => [SYSTEM],
      route_breadcrumb: () => [],
    });
    renderWithQuery(<RoutePage />);

    expect(await screen.findByText("Jita")).toBeInTheDocument();
  });

  it("shows the activity-load failure message", async () => {
    const error: AppError = {
      kind: "message",
      message: "zKillboard timed out",
    };
    mockInvoke({
      sde_status: () => SDE_OK,
      route_system_activity: () => {
        throw error;
      },
      route_breadcrumb: () => [],
    });
    renderWithQuery(<RoutePage />);

    expect(await screen.findByText(/zKillboard timed out/)).toBeInTheDocument();
  });

  it("renders the neighbourhood graph and distance column in Around mode", async () => {
    localStorage.setItem("route.mode", JSON.stringify("neighbouring"));
    localStorage.setItem(
      "route.centre",
      JSON.stringify({ id: 30000142, name: "Jita" }),
    );
    mockInvoke({
      sde_status: () => SDE_OK,
      route_system_activity: () => [],
      route_breadcrumb: () => [],
      route_system_neighbourhood: () => ({
        center: 30000142,
        nodes: [
          { ...SYSTEM, distance: 0 },
          {
            ...SYSTEM,
            systemId: 30000144,
            name: "Perimeter",
            security: 1.0,
            distance: 1,
          },
        ],
        edges: [[30000142, 30000144]],
      }),
    });
    renderWithQuery(<RoutePage />);

    // Distance column appears, the graph renders both systems (each name
    // shows in the graph *and* the table), and the centre is marked.
    expect(await screen.findByText("Dist")).toBeInTheDocument();
    const perimeters = await screen.findAllByText("Perimeter");
    expect(perimeters.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("0.9 · centre")).toBeInTheDocument();
  });

  it("prompts to log in when locating the character requires auth", async () => {
    const error: AppError = { kind: "authRequired", message: "no character" };
    mockInvoke({
      sde_status: () => SDE_OK,
      route_system_activity: () => [],
      route_breadcrumb: () => [],
      route_location: () => {
        throw error;
      },
    });
    renderWithQuery(<RoutePage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /my location/i }),
    );

    expect(
      await screen.findByText(/log in a character first/i),
    ).toBeInTheDocument();
  });
});
