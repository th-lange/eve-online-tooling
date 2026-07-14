import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PvpProfilesResult } from "../../lib/api";

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
    },
  ],
  unresolved: ["Nobody"],
};

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
  });

  it("disables the button until names are entered", () => {
    invokeMock.mockResolvedValue(RESULT);
    renderPage();
    expect(
      screen.getByRole("button", { name: /profile pilots/i }),
    ).toBeDisabled();
  });
});
