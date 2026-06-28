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

// Two modules in the same section (Industry) and one in another (Trading),
// used to exercise within-section reordering vs. the cross-section guard.
const id = (title: string) => modules.find((m) => m.title === title)!.id;
const PRODUCTION = "Production"; // industry
const REPROCESSING = "Reprocessing"; // industry
const TRADING = "Station Trading"; // trading

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

describe("Layout sidebar", () => {
  beforeEach(() => localStorage.clear());

  it("renders labelled group sections in order", () => {
    renderLayout();
    const nav = screen.getByRole("navigation");
    // (Labels chosen to not collide with any module's own title text.)
    for (const label of ["Industry", "Trading", "Intel / Space"]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    // Industry is the first section, so its members lead the list.
    expect(navOrder().slice(0, 2)).toEqual([PRODUCTION, REPROCESSING]);
  });

  it("drag-reorders within a section and persists the order", () => {
    renderLayout();
    fireEvent.dragStart(handleFor(REPROCESSING));
    fireEvent.drop(rowFor(PRODUCTION));

    expect(navOrder().slice(0, 2)).toEqual([REPROCESSING, PRODUCTION]);
    const saved = JSON.parse(localStorage.getItem("sidebar.order") ?? "[]");
    expect(saved.slice(0, 2)).toEqual([id(REPROCESSING), id(PRODUCTION)]);
  });

  it("does not reorder across section boundaries", () => {
    renderLayout();
    const before = navOrder();
    // Station Trading lives in a different section than Production.
    fireEvent.dragStart(handleFor(TRADING));
    fireEvent.drop(rowFor(PRODUCTION));

    expect(navOrder()).toEqual(before);
    expect(localStorage.getItem("sidebar.order")).toBeNull();
  });

  it("restores a saved within-section order on mount", () => {
    localStorage.setItem(
      "sidebar.order",
      JSON.stringify([id(REPROCESSING), id(PRODUCTION)]),
    );
    renderLayout();
    expect(navOrder().slice(0, 2)).toEqual([REPROCESSING, PRODUCTION]);
  });

  it("pinning lifts a module into the Pinned section", () => {
    localStorage.setItem("sidebar.pins", JSON.stringify([id(TRADING)]));
    renderLayout();
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByText("Pinned")).toBeInTheDocument();
    // The pinned module now leads the whole nav.
    expect(navOrder()[0]).toBe(TRADING);
  });

  it("assigns an accent colour and persists it; clearing removes it", () => {
    renderLayout();
    const row = rowFor(PRODUCTION);

    fireEvent.click(
      within(row).getByRole("button", { name: `Set colour for ${PRODUCTION}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Emerald" }));

    expect(JSON.parse(localStorage.getItem("sidebar.colors") ?? "{}")).toEqual({
      [id(PRODUCTION)]: "emerald",
    });
    expect(screen.getByRole("link", { name: PRODUCTION })).toHaveStyle({
      boxShadow: "inset 3px 0 0 #34d399",
    });

    fireEvent.click(
      within(row).getByRole("button", { name: `Set colour for ${PRODUCTION}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear colour" }));
    expect(JSON.parse(localStorage.getItem("sidebar.colors") ?? "{}")).toEqual({});
  });

  it("restores saved colours on mount", () => {
    localStorage.setItem(
      "sidebar.colors",
      JSON.stringify({ [id(TRADING)]: "sky" }),
    );
    renderLayout();
    expect(screen.getByRole("link", { name: TRADING })).toHaveStyle({
      boxShadow: "inset 3px 0 0 #38bdf8",
    });
  });
});
