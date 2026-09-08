import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AmmoTable } from "./AmmoTable";
import type { AmmoRow, Fit } from "../../lib/api";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const FIT: Fit = { id: "", name: "t", shipTypeId: 587, items: [] };

function renderTable() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<AmmoTable fit={FIT} skillSource="allFive" />, { wrapper });
}

beforeEach(() => invokeMock.mockReset());

describe("AmmoTable", () => {
  it("lists each cargo ammo with dps, range and tracking", async () => {
    const rows: AmmoRow[] = [
      {
        typeId: 1,
        name: "EMP S",
        dps: 150,
        optimal: 1500,
        falloff: 4000,
        tracking: 0.19,
      },
      {
        typeId: 2,
        name: "Barrage S",
        dps: 120,
        optimal: 2000,
        falloff: 6000,
        tracking: 0.19,
      },
    ];
    invokeMock.mockResolvedValue(rows);
    renderTable();

    expect(await screen.findByText("EMP S")).toBeInTheDocument();
    expect(screen.getByText("Barrage S")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument(); // dps
    expect(screen.getByText("2.0 km")).toBeInTheDocument(); // optimal
    expect(screen.getByText("+6.0 km")).toBeInTheDocument(); // falloff
    expect(screen.getAllByText("0.190").length).toBeGreaterThan(0); // tracking
  });

  it("renders nothing when no cargo ammo is loadable", async () => {
    invokeMock.mockResolvedValue([]);
    renderTable();
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByText(/cargo ammo/i)).toBeNull();
  });

  it("shows a dash for missiles (no tracking / no falloff)", async () => {
    const rows: AmmoRow[] = [
      {
        typeId: 3,
        name: "Scourge Fury Light Missile",
        dps: 90,
        optimal: 40000,
        falloff: 0,
        tracking: 0,
      },
    ];
    invokeMock.mockResolvedValue(rows);
    renderTable();
    expect(
      await screen.findByText("Scourge Fury Light Missile"),
    ).toBeInTheDocument();
    // Falloff and tracking both dash for a missile.
    expect(screen.getAllByText("—").length).toBe(2);
  });
});
