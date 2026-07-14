import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PvpProfilesResult, LostFit } from "../../lib/api";

const RESULT: PvpProfilesResult = {
  pilots: [
    {
      characterId: 42,
      name: "Hunter",
      shipsDestroyed: 120,
      shipsLost: 8,
      iskDestroyed: 5.2e10,
      iskLost: 2.0e9,
      soloKills: 30,
      soloLosses: 2,
      dangerRatio: 88,
      gangRatio: 40,
      active: true,
      hulls: [
        { typeId: 587, name: "Rifter", kills: 40 },
        { typeId: 621, name: "Caracal", kills: 12 },
      ],
    },
  ],
  unresolved: ["Nobody"],
};

const FITS: LostFit[] = [
  {
    hullTypeId: 587,
    hullName: "Rifter",
    lostCount: 3,
    killmailId: 111,
    modules: [
      { typeId: 100, name: "200mm AutoCannon II", slot: "high", quantity: 1 },
      { typeId: 200, name: "Warp Scrambler II", slot: "mid", quantity: 1 },
    ],
  },
];

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { PvpPage } from "./PvpPage";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PvpPage />
    </QueryClientProvider>,
  );
}

describe("PvpPage", () => {
  it("profiles pasted pilots and renders per-pilot stats", async () => {
    invokeMock.mockResolvedValue(RESULT);
    renderPage();

    fireEvent.change(screen.getByPlaceholderText(/paste pilot names/i), {
      target: { value: "Hunter\nNobody" },
    });
    fireEvent.click(screen.getByRole("button", { name: /profile pilots/i }));

    // The command is called with the pasted text.
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pvp_profiles", {
        text: "Hunter\nNobody",
      }),
    );

    expect(screen.getByText(/resolve: Nobody/i)).toBeInTheDocument(); // unresolved
    expect(await screen.findByText("Hunter")).toBeInTheDocument();
    expect(screen.getByText(/danger 88%/i)).toBeInTheDocument();
    expect(screen.getByText("52.0B")).toBeInTheDocument(); // 5.2e10 → 52.0B
    // "Flies" hull chip from the topLists data.
    expect(await screen.findByText("Rifter")).toBeInTheDocument();
  });

  it("disables the button until names are entered", () => {
    invokeMock.mockResolvedValue(RESULT);
    renderPage();
    expect(
      screen.getByRole("button", { name: /profile pilots/i }),
    ).toBeDisabled();
  });

  it("loads a pilot's lost fits on expand", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "pvp_pilot_fits"
        ? Promise.resolve(FITS)
        : Promise.resolve(RESULT),
    );
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/paste pilot names/i), {
      target: { value: "Hunter" },
    });
    fireEvent.click(screen.getByRole("button", { name: /profile pilots/i }));
    await screen.findByText("Hunter");

    fireEvent.click(screen.getByRole("button", { name: /show lost fits/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pvp_pilot_fits", {
        characterId: 42,
      }),
    );
    // A module from the reconstructed fit renders.
    expect(await screen.findByText(/Warp Scrambler II/)).toBeInTheDocument();
  });
});
