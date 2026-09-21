import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { FactionWarfarePage } from "./FactionWarfarePage";
import type { FwSystemNode } from "../../lib/api";

function node(name: string, contested: string, id: number): FwSystemNode {
  return {
    systemId: id, name, region: "Devoid", warzone: "Amarr–Minmatar",
    security: 0.3, owner: "Amarr", occupier: "Amarr", ownerId: 500003,
    occupierId: 500003, contested, vpPct: contested === "uncontested" ? 0 : 0.5,
    kills: 0, jumps: 0, x: id * 1e15, z: id * 1e15,
  };
}
const NODES = [
  node("QuietTown", "uncontested", 1),
  node("FightVille", "contested", 2),
  node("VulnBurg", "vulnerable", 3),
];

// The star map renders system names too, so scope row assertions to the table.
const inTable = () => within(screen.getByRole("table"));

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  mockInvoke({
    intel_fw_stats: () => [],
    intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
    auth_characters: () => [],
    auth_active_character: () => null,
  });
});

describe("FW warzone list filter", () => {
  it("filters the system table by contested / uncontested / all", async () => {
    renderWithQuery(<FactionWarfarePage />);
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(inTable().getByText("FightVille")).toBeInTheDocument();
    expect(inTable().getByText("VulnBurg")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Contested" }));
    await waitFor(() =>
      expect(inTable().queryByText("QuietTown")).not.toBeInTheDocument(),
    );
    expect(inTable().getByText("FightVille")).toBeInTheDocument();
    expect(inTable().getByText("VulnBurg")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Uncontested" }));
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(inTable().queryByText("FightVille")).not.toBeInTheDocument();
    expect(inTable().queryByText("VulnBurg")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(inTable().getByText("FightVille")).toBeInTheDocument(),
    );
    expect(inTable().getByText("QuietTown")).toBeInTheDocument();
    expect(inTable().getByText("VulnBurg")).toBeInTheDocument();
  });
});
