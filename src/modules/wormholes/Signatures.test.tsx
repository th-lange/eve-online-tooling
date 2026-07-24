import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";

import { Signatures } from "./Signatures";

const THERA = { id: 31000005, name: "Thera" };

const STORED = [
  {
    id: "ABC-123",
    group: "Cosmic Signature",
    sigType: "Wormhole",
    name: "Unstable Wormhole",
  },
  {
    id: "XYZ-789",
    group: "Cosmic Signature",
    sigType: "Data",
    name: "Ruined Site",
  },
];

beforeEach(() => {
  invokeMock.mockReset();
});

describe("Signatures", () => {
  it("shows stored signatures as soon as a system is selected", async () => {
    mockInvoke({ wh_signatures: () => STORED });
    renderWithQuery(
      <Signatures connections={[]} system={THERA} setSystem={() => {}} />,
    );

    expect(await screen.findByText("ABC-123")).toBeInTheDocument();
    expect(screen.getByText("XYZ-789")).toBeInTheDocument();
  });

  it("shows the paste diff on top of the refreshed set", async () => {
    mockInvoke({
      wh_signatures: () => [STORED[0]],
      wh_paste_signatures: () => ({
        signatures: STORED,
        added: ["XYZ-789"],
        removed: [],
      }),
    });
    renderWithQuery(
      <Signatures connections={[]} system={THERA} setSystem={() => {}} />,
    );
    expect(await screen.findByText("ABC-123")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/probe-scanner/i), {
      target: { value: "XYZ-789\tCosmic Signature\tData\tRuined Site" },
    });
    fireEvent.click(screen.getByRole("button", { name: /update signatures/i }));

    expect(await screen.findByText("+1 new")).toBeInTheDocument();
    expect(screen.getByText("XYZ-789")).toBeInTheDocument();
  });

  it("shows the empty state for a system with no stored signatures", async () => {
    mockInvoke({ wh_signatures: () => [] });
    renderWithQuery(
      <Signatures connections={[]} system={THERA} setSystem={() => {}} />,
    );

    expect(
      await screen.findByText(/no stored signatures for this system/i),
    ).toBeInTheDocument();
  });
});
