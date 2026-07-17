import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { AppError, LocalPilot, LocalScanResult } from "../../lib/api";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";

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
      local_scan: () => RESULT,
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
      local_scan: () => {
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
});
