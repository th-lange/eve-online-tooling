import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PvpProfilesResult, LostFit } from "../../lib/api";
import { MemoryRouter } from "react-router-dom";
import { takePendingFitImport } from "../../lib/deepLink";

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
    lastLost: "2026-07-10T14:00:00Z",
    modules: [
      { typeId: 100, name: "200mm AutoCannon II", slot: "high", quantity: 1 },
      { typeId: 200, name: "Warp Scrambler II", slot: "mid", quantity: 1 },
    ],
    eft: "[Rifter, Rifter]\n\n200mm AutoCannon II\nWarp Scrambler II",
    analysis: {
      ehp: 12000,
      dpsTotal: 180,
      dpsTurret: 150,
      dpsMissile: 0,
      dpsDrone: 30,
      scramRange: 9000,
      maxVelocity: 3200,
      hasProp: true,
      lockRange: 60000,
      weapons: [{ typeId: 2873, name: "200mm AutoCannon II", optimal: 2000, falloff: 6000, tracking: 0.18 }],
    },
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
      <MemoryRouter>
        <PvpPage />
      </MemoryRouter>
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
    // The pilot name links to their zKillboard character page.
    const link = await screen.findByRole("link", { name: /Hunter/ });
    expect(link).toHaveAttribute(
      "href",
      "https://zkillboard.com/character/42/",
    );
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
    // The all-V analysis renders (scram range + EHP).
    expect(screen.getByText(/9\.0 km/)).toBeInTheDocument();
    expect(screen.getByText(/12,000/)).toBeInTheDocument();
  });

  it("limits how many lost fits render, with a 'more' hint", async () => {
    const manyFits: LostFit[] = Array.from({ length: 6 }, (_, i) => ({
      hullTypeId: 587,
      hullName: "Rifter",
      lostCount: 1,
      killmailId: 1000 + i,
      lastLost: "2026-07-01T00:00:00Z",
      modules: [],
      eft: "[Rifter, Rifter]",
    }));
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "pvp_pilot_fits"
        ? Promise.resolve(manyFits)
        : Promise.resolve(RESULT),
    );
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/paste pilot names/i), {
      target: { value: "Hunter" },
    });
    fireEvent.click(screen.getByRole("button", { name: /profile pilots/i }));
    await screen.findByText("Hunter");
    fireEvent.click(screen.getByRole("button", { name: /show lost fits/i }));
    // Default limit is 5, so the 6th is hidden behind a "+1 more" hint.
    expect(await screen.findByText(/\+1 more/)).toBeInTheDocument();
    // Raising the limit to 10 shows them all — the hint disappears.
    fireEvent.click(screen.getByRole("button", { name: "10" }));
    await waitFor(() =>
      expect(screen.queryByText(/\+1 more/)).not.toBeInTheDocument(),
    );
  });

  it("offers Copy EFT and Simulate on a lost fit", async () => {
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
    await screen.findByText(/Warp Scrambler II/);

    // Copy EFT acknowledges with a transient "Copied".
    fireEvent.click(screen.getByRole("button", { name: /copy eft/i }));
    expect(
      await screen.findByRole("button", { name: /copied/i }),
    ).toBeInTheDocument();

    // Simulate stashes the fit for the Fitting module to pick up.
    fireEvent.click(screen.getByRole("button", { name: /simulate/i }));
    const eft = takePendingFitImport();
    expect(eft).toContain("[Rifter, Rifter]");
    expect(eft).toContain("Warp Scrambler II");
  });

  it("offers a community typical fit for a flown-but-not-lost hull", async () => {
    const TYPICAL: LostFit = {
      hullTypeId: 621,
      hullName: "Caracal",
      lostCount: 25,
      killmailId: 222,
      lastLost: "2026-07-01T00:00:00Z",
      modules: [
        {
          typeId: 300,
          name: "Caldari Navy Ballistic Control System",
          slot: "low",
          quantity: 1,
        },
      ],
      eft: "[Caracal, Caracal]\n\nCaldari Navy Ballistic Control System",
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pvp_pilot_fits") return Promise.resolve(FITS); // lost: Rifter
      if (cmd === "pvp_typical_fit") return Promise.resolve(TYPICAL);
      return Promise.resolve(RESULT); // flies Rifter + Caracal
    });
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/paste pilot names/i), {
      target: { value: "Hunter" },
    });
    fireEvent.click(screen.getByRole("button", { name: /profile pilots/i }));
    await screen.findByText("Hunter");
    fireEvent.click(screen.getByRole("button", { name: /show lost fits/i }));

    // Caracal is flown but not among the losses → offered as a typical fit.
    const btn = await screen.findByRole("button", {
      name: /Caracal typical fit/i,
    });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pvp_typical_fit", {
        hullTypeId: 621,
      }),
    );
    expect(
      await screen.findByText(/Caldari Navy Ballistic Control System/),
    ).toBeInTheDocument();
    expect(screen.getByText(/typical · community/)).toBeInTheDocument();
  });

  it("submits on Enter and not on Shift+Enter", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(RESULT);
    renderPage();
    const box = screen.getByPlaceholderText(/paste pilot names/i);
    fireEvent.change(box, { target: { value: "Hunter" } });
    // Shift+Enter is a newline, not a submit.
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(invokeMock).not.toHaveBeenCalled();
    // Plain Enter submits.
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pvp_profiles", {
        text: "Hunter",
      }),
    );
  });

  it("notes when a pilot has no flown-ship data", async () => {
    invokeMock.mockResolvedValue({
      pilots: [{ ...RESULT.pilots[0], hulls: [] }],
      unresolved: [],
    });
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/paste pilot names/i), {
      target: { value: "Hunter" },
    });
    fireEvent.click(screen.getByRole("button", { name: /profile pilots/i }));
    expect(await screen.findByText(/no flown-ship data/i)).toBeInTheDocument();
  });
});
