import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Sidebar children (Characters, BridgeStatus) reach into the Tauri bridge; stub
// it so the shell renders without a desktop host.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { Layout } from "./Layout";
import { modules } from "../modules/registry";

function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Layout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Visible nav labels, top-to-bottom. */
function navOrder(): string[] {
  return within(screen.getByRole("navigation"))
    .getAllByRole("link")
    .map((a) => a.textContent ?? "");
}

/** The draggable handle within the row whose link text is `title`. */
function handleFor(title: string): HTMLElement {
  const link = screen.getByRole("link", { name: title });
  const row = link.parentElement as HTMLElement;
  return within(row).getByTitle("Drag to reorder");
}

function rowFor(title: string): HTMLElement {
  return screen.getByRole("link", { name: title }).parentElement as HTMLElement;
}

describe("Layout sidebar reordering", () => {
  beforeEach(() => localStorage.clear());

  it("renders modules in registry order by default", () => {
    renderLayout();
    expect(navOrder().slice(0, 3)).toEqual(
      modules.slice(0, 3).map((m) => m.title),
    );
  });

  it("drag-reorders a module before another and persists the order", () => {
    renderLayout();
    const [first, second, third] = modules.map((m) => m.title);

    // Drag the third module onto the first → it lands before it.
    fireEvent.dragStart(handleFor(third));
    fireEvent.drop(rowFor(first));

    expect(navOrder().slice(0, 3)).toEqual([third, first, second]);

    const saved = JSON.parse(localStorage.getItem("sidebar.order") ?? "[]");
    expect(saved.slice(0, 3)).toEqual([
      modules[2].id,
      modules[0].id,
      modules[1].id,
    ]);
  });

  it("restores a saved order on mount", () => {
    const custom = [modules[1].id, modules[0].id];
    localStorage.setItem("sidebar.order", JSON.stringify(custom));
    renderLayout();
    expect(navOrder().slice(0, 2)).toEqual([modules[1].title, modules[0].title]);
  });

  it("assigns an accent colour and persists it; clearing removes it", () => {
    renderLayout();
    const title = modules[0].title;
    const row = rowFor(title);

    // Open the picker for the first module and choose Emerald.
    fireEvent.click(within(row).getByRole("button", { name: `Set colour for ${title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Emerald" }));

    expect(JSON.parse(localStorage.getItem("sidebar.colors") ?? "{}")).toEqual({
      [modules[0].id]: "emerald",
    });
    // The accent renders as an inset box-shadow on the link.
    expect(screen.getByRole("link", { name: title })).toHaveStyle({
      boxShadow: "inset 3px 0 0 #34d399",
    });

    // Clearing removes the entry from the saved map.
    fireEvent.click(within(row).getByRole("button", { name: `Set colour for ${title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Clear colour" }));
    expect(JSON.parse(localStorage.getItem("sidebar.colors") ?? "{}")).toEqual({});
  });

  it("restores saved colours on mount", () => {
    localStorage.setItem(
      "sidebar.colors",
      JSON.stringify({ [modules[1].id]: "sky" }),
    );
    renderLayout();
    expect(screen.getByRole("link", { name: modules[1].title })).toHaveStyle({
      boxShadow: "inset 3px 0 0 #38bdf8",
    });
  });

  it("does not reorder across the pinned / unpinned boundary", () => {
    // Pin the first module; dragging an unpinned row onto it should be a no-op.
    localStorage.setItem("sidebar.pins", JSON.stringify([modules[0].id]));
    renderLayout();

    const before = navOrder();
    fireEvent.dragStart(handleFor(modules[2].title));
    fireEvent.drop(rowFor(modules[0].title));

    expect(navOrder()).toEqual(before);
    expect(localStorage.getItem("sidebar.order")).toBeNull();
  });
});
