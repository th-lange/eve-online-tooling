import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { AppError, LocalPilot, LocalScanResult } from "../../lib/api";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { ModuleActiveContext } from "../../components/moduleActiveContext";

import { LocalIntelPage } from "./LocalIntelPage";

const PILOT: LocalPilot = {
  characterId: 12345,
  name: "Chribba",
  corporationId: 98765,
  corporation: "Otherworld Enterprises",
  allianceId: null,
  alliance: null,
  standing: 0,
  threat: "neutral",
};

const RESULT: LocalScanResult = {
  pilots: [PILOT],
  reds: 0,
  neutrals: 1,
  blues: 0,
  unresolved: [],
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("LocalIntelPage", () => {
  it("scans pasted names and renders a classified pilot", async () => {
    mockInvoke({
      localintel_scan: () => RESULT,
      localintel_zkill: () => [],
    });
    renderWithQuery(<LocalIntelPage />);

    fireEvent.change(
      screen.getByPlaceholderText(/paste the local member list/i),
      { target: { value: "Chribba" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /scan local/i }));

    expect(await screen.findByText("Chribba")).toBeInTheDocument();
  });

  it("shows the scan failure message", async () => {
    const error: AppError = { kind: "message", message: "ESI unreachable" };
    mockInvoke({
      localintel_scan: () => {
        throw error;
      },
    });
    renderWithQuery(<LocalIntelPage />);

    fireEvent.change(
      screen.getByPlaceholderText(/paste the local member list/i),
      { target: { value: "Chribba" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /scan local/i }));

    expect(await screen.findByText(/ESI unreachable/)).toBeInTheDocument();
  });

  it("polls the character location while the module is active", async () => {
    mockInvoke({ route_location: () => [] });
    renderWithQuery(<LocalIntelPage />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("route_location"),
    );
  });

  it("does not poll the character location while the module is hidden", async () => {
    mockInvoke({ route_location: () => [] });
    renderWithQuery(
      <ModuleActiveContext.Provider value={false}>
        <LocalIntelPage />
      </ModuleActiveContext.Provider>,
    );

    // Let any (wrongly) scheduled fetch flush before asserting.
    await new Promise((r) => setTimeout(r, 50));
    expect(invokeMock).not.toHaveBeenCalledWith("route_location");
  });
});
