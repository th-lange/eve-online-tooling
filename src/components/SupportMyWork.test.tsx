import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The link button reaches the Tauri opener; stub it so the component renders.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { SupportModal, CorpRow, CORP_ID } from "./SupportMyWork";

describe("Support my work", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
  });

  it("shows the first-run modal until dismissed, then remembers", () => {
    render(<SupportModal />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Creator code row explains the on-hold state instead of a copy field.
    expect(screen.getByText("Creator code")).toBeInTheDocument();
    expect(screen.getByText(/On hold/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem("support.firstRunSeen")).toBe("1");
  });

  it("does not show the modal once it has been seen", () => {
    localStorage.setItem("support.firstRunSeen", "1");
    render(<SupportModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking 'Support my corp' opens the corp's in-game info window and says where", async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<CorpRow />);
    fireEvent.click(screen.getByRole("button", { name: "Support my corp" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("esi_open_info_window", {
        targetId: CORP_ID,
      }),
    );
    // The silent-no-op gotcha is spelled out: the window opens on the active
    // character's client, and only while that character is in-game.
    await waitFor(() =>
      expect(
        screen.getByText(/active character's game client/),
      ).toBeInTheDocument(),
    );
  });

  it("surfaces an inline error when the open-window call fails", async () => {
    invokeMock.mockRejectedValue("no scope");
    render(<CorpRow />);
    fireEvent.click(screen.getByRole("button", { name: "Support my corp" }));
    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't open it: no scope/),
      ).toBeInTheDocument(),
    );
  });
});
