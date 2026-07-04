import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// The link button reaches the Tauri opener; stub it so the component renders.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { SupportModal } from "./SupportMyWork";

describe("Support my work", () => {
  beforeEach(() => localStorage.clear());

  it("shows the first-run modal until dismissed, then remembers", () => {
    render(<SupportModal />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Creator code")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem("support.firstRunSeen")).toBe("1");
  });

  it("does not show the modal once it has been seen", () => {
    localStorage.setItem("support.firstRunSeen", "1");
    render(<SupportModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
