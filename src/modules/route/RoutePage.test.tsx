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
