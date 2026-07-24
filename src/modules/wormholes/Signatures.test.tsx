import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import type { ConnectionView } from "../../lib/api";

import { Signatures } from "./Signatures";

const THERA = { id: 31000005, name: "Thera" };

const CONNECTION: ConnectionView = {
  id: 7,
  sourceSystemId: 31000005,
  sourceName: "Thera",
  sourceWspace: true,
  targetSystemId: 30000142,
  targetName: "Jita",
  targetWspace: false,
  scope: "wormhole",
  massStatus: "fresh",
  jumpMass: "xl",
  eol: false,
  sourceSig: "ABC",
  targetSig: null,
  source: "manual",
  createdAt: 0,
};

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
      <Signatures
        connections={[]}
        system={THERA}
        setSystem={() => {}}
        onDeleteConnection={() => {}}
      />,
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
        needsConfirmation: false,
        affectedConnectionIds: [],
      }),
    });
    renderWithQuery(
      <Signatures
        connections={[]}
        system={THERA}
        setSystem={() => {}}
        onDeleteConnection={() => {}}
      />,
    );
    expect(await screen.findByText("ABC-123")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/probe-scanner/i), {
      target: { value: "XYZ-789\tCosmic Signature\tData\tRuined Site" },
    });
    fireEvent.click(screen.getByRole("button", { name: /update signatures/i }));

    expect(await screen.findByText("+1 new")).toBeInTheDocument();
    expect(screen.getByText("XYZ-789")).toBeInTheDocument();
  });

  it("holds back a destructive paste until confirmed", async () => {
    mockInvoke({
      wh_signatures: () => STORED,
      wh_paste_signatures: () => ({
        signatures: STORED,
        added: [],
        removed: ["ABC-123", "XYZ-789"],
        needsConfirmation: true,
        affectedConnectionIds: [],
      }),
    });
    renderWithQuery(
      <Signatures
        connections={[]}
        system={THERA}
        setSystem={() => {}}
        onDeleteConnection={() => {}}
      />,
    );
    await screen.findByText("ABC-123");

    fireEvent.change(screen.getByPlaceholderText(/probe-scanner/i), {
      target: { value: "QQQ-111\tCosmic Signature\tData\tSite" },
    });
    fireEvent.click(screen.getByRole("button", { name: /update signatures/i }));

    // The guard shows, the stored set is untouched, and the textarea keeps
    // its content for the forced re-send.
    expect(
      await screen.findByRole("button", { name: /replace anyway/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/removes 2 of 2 stored/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/probe-scanner/i)).toHaveValue(
      "QQQ-111\tCosmic Signature\tData\tSite",
    );
  });

  it("flags connections whose endpoint sig disappeared", async () => {
    const onDelete = vi.fn();
    mockInvoke({
      wh_signatures: () => [STORED[1]],
      wh_paste_signatures: () => ({
        signatures: [STORED[1]],
        added: [],
        removed: ["ABC-123"],
        needsConfirmation: false,
        affectedConnectionIds: [7],
      }),
    });
    renderWithQuery(
      <Signatures
        connections={[CONNECTION]}
        system={THERA}
        setSystem={() => {}}
        onDeleteConnection={onDelete}
      />,
    );
    await screen.findByText("XYZ-789");

    fireEvent.change(screen.getByPlaceholderText(/probe-scanner/i), {
      target: { value: "XYZ-789\tCosmic Signature\tData\tRuined Site" },
    });
    fireEvent.click(screen.getByRole("button", { name: /update signatures/i }));

    expect(await screen.findByText(/sig gone/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /delete connection/i }));
    expect(onDelete).toHaveBeenCalledWith(7);
  });

  it("shows the empty state for a system with no stored signatures", async () => {
    mockInvoke({ wh_signatures: () => [] });
    renderWithQuery(
      <Signatures
        connections={[]}
        system={THERA}
        setSystem={() => {}}
        onDeleteConnection={() => {}}
      />,
    );

    expect(
      await screen.findByText(/no stored signatures for this system/i),
    ).toBeInTheDocument();
  });
});
