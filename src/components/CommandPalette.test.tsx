import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// sdeSearch goes through the Tauri bridge; stub it (no item matches needed).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

import { CommandPalette } from "./CommandPalette";

function LocationProbe() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

function renderPalette() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/production"]}>
        <CommandPalette />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CommandPalette", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is hidden until the ⌘K hotkey opens it", () => {
    renderPalette();
    expect(screen.queryByPlaceholderText(/Jump to a module/)).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByPlaceholderText(/Jump to a module/)).toBeInTheDocument();
  });

  it("opens via the palette:open event", () => {
    renderPalette();
    fireEvent(window, new Event("palette:open"));
    expect(screen.getByPlaceholderText(/Jump to a module/)).toBeInTheDocument();
  });

  it("fuzzy-filters modules and navigates on Enter", () => {
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByPlaceholderText(/Jump to a module/);

    fireEvent.change(input, { target: { value: "wormh" } });
    // Only the Wormholes module survives the fuzzy filter.
    expect(screen.getByText("Wormholes")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("path")).toHaveTextContent("/wormholes");
    // Palette closes after activation.
    expect(screen.queryByPlaceholderText(/Jump to a module/)).toBeNull();
  });

  it("closes on Escape", () => {
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByPlaceholderText(/Jump to a module/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByPlaceholderText(/Jump to a module/)).toBeNull();
  });
});
