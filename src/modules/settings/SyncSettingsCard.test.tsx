import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const pickFolder = vi.fn();
const syncNowMock = vi.fn();
vi.mock("../../lib/api", () => ({
  errorMessage: (e: unknown) => String(e),
  pickSyncFolder: (...a: unknown[]) => pickFolder(...a),
}));
vi.mock("../../lib/sync/syncNow", () => ({
  syncNow: (...a: unknown[]) => syncNowMock(...a),
  pushAll: vi.fn(),
  pullAll: vi.fn(),
}));

import { SyncSettingsCard } from "./SyncSettingsCard";

beforeEach(() => {
  localStorage.clear();
  pickFolder.mockReset();
  syncNowMock.mockReset();
  syncNowMock.mockResolvedValue({ imported: [], exported: [], unchanged: [] });
});

describe("SyncSettingsCard", () => {
  it("picks a folder, then Activate gates the sync actions", async () => {
    pickFolder.mockResolvedValue("/shared/sync");
    render(<SyncSettingsCard />);

    const syncBtn = screen.getByRole("button", { name: "Sync now" });
    expect(syncBtn).toBeDisabled(); // no folder, not activated

    // Clicking the folder field opens the native picker and stores the choice.
    fireEvent.click(screen.getByRole("button", { name: "Choose sync folder" }));
    await screen.findByText("/shared/sync");
    expect(pickFolder).toHaveBeenCalled();

    // Still gated until activated.
    expect(syncBtn).toBeDisabled();
    expect(screen.getByText(/click Activate to turn sync on/)).toBeVisible();

    // Activate turns it on; the action becomes available and runs.
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(
      screen.getByRole("button", { name: "Active ✓" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(syncBtn).toBeEnabled());

    fireEvent.click(syncBtn);
    await waitFor(() =>
      expect(syncNowMock).toHaveBeenCalledWith("/shared/sync"),
    );
  });

  it("won't activate without a folder", () => {
    render(<SyncSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(screen.getByText("Choose a folder first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
  });
});
