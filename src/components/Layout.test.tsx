import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Sidebar children (Characters, BridgeStatus) reach into the Tauri bridge; stub
// it so the shell renders without a desktop host.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";

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

function rowFor(title: string): HTMLElement {
  return screen.getByRole("link", { name: title }).parentElement as HTMLElement;
}

/** The row for `title` in the Pinned section (first instance, when mirrored). */
function pinnedRowFor(title: string): HTMLElement {
  return screen.getAllByRole("link", { name: title })[0]
    .parentElement as HTMLElement;
}

/** The draggable handle of the Pinned-section row for `title`. */
function pinnedHandleFor(title: string): HTMLElement {
  return within(pinnedRowFor(title)).getByTitle("Drag to reorder");
}

describe("Layout sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  });

  it("renders labelled group sections in order", () => {
    renderLayout();
    const nav = screen.getByRole("navigation");
    // (Labels chosen to not collide with any module's own title text.)
    for (const label of ["Industry", "Trading", "Combat / Intel"]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    // Industry is the first section, so its members lead the list.
    expect(navOrder().slice(0, 2)).toEqual([PRODUCTION, REPROCESSING]);
  });

  it("drag-reorders pinned modules and persists the order", () => {
    localStorage.setItem(
      "sidebar.pins",
      JSON.stringify([id(PRODUCTION), id(TRADING)]),
    );
    renderLayout();
    // Pinned section leads with [Production, Trading] (registry order).
    expect(navOrder().slice(0, 2)).toEqual([PRODUCTION, TRADING]);

    fireEvent.dragStart(pinnedHandleFor(TRADING));
    fireEvent.drop(pinnedRowFor(PRODUCTION));

    expect(navOrder()[0]).toBe(TRADING);
    const saved = JSON.parse(localStorage.getItem("sidebar.order") ?? "[]");
    expect(saved.slice(0, 2)).toEqual([id(TRADING), id(PRODUCTION)]);
  });

  it("group sections are not drag-sortable (no handle)", () => {
    renderLayout();
    // Production (unpinned) sits only in its Industry group, with no drag handle.
    expect(
      within(rowFor(PRODUCTION)).queryByTitle("Drag to reorder"),
    ).toBeNull();
  });

  it("restores a saved pinned order on mount", () => {
    localStorage.setItem(
      "sidebar.pins",
      JSON.stringify([id(PRODUCTION), id(TRADING)]),
    );
    localStorage.setItem(
      "sidebar.order",
      JSON.stringify([id(TRADING), id(PRODUCTION)]),
    );
    renderLayout();
    // Pinned section reflects the saved order.
    expect(navOrder()[0]).toBe(TRADING);
  });

  it("has no Pinned section when nothing is pinned", () => {
    renderLayout();
    expect(screen.queryByText("Pinned")).toBeNull();
  });

  it("mirrors a pinned module into Pinned while keeping it in its group", () => {
    localStorage.setItem("sidebar.pins", JSON.stringify([id(TRADING)]));
    renderLayout();
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByText("Pinned")).toBeInTheDocument();
    // The pinned module leads the nav (Pinned section is first) …
    expect(navOrder()[0]).toBe(TRADING);
    // … and still appears in its own Trading section, so it shows twice.
    expect(screen.getAllByRole("link", { name: TRADING })).toHaveLength(2);
  });

  it("sections default to open", () => {
    renderLayout();
    expect(screen.getByRole("link", { name: PRODUCTION })).toBeInTheDocument();
  });

  it("collapses a section on header click and persists it", () => {
    renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Industry" }));
    expect(screen.queryByRole("link", { name: PRODUCTION })).toBeNull();
    expect(
      JSON.parse(localStorage.getItem("sidebar.collapsed") ?? "[]"),
    ).toContain("industry");
  });

  it("restores collapsed sections on mount", () => {
    localStorage.setItem("sidebar.collapsed", JSON.stringify(["industry"]));
    renderLayout();
    expect(screen.queryByRole("link", { name: PRODUCTION })).toBeNull();
    // Other sections stay open.
    expect(screen.getByRole("link", { name: TRADING })).toBeInTheDocument();
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
    expect(JSON.parse(localStorage.getItem("sidebar.colors") ?? "{}")).toEqual(
      {},
    );
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

  it("hides a module from its page into the Hidden section and persists it", () => {
    renderLayout();
    // The hide control now lives on the module page (the default active module
    // is the first one, Production).
    fireEvent.click(
      screen.getByRole("button", { name: `Hide ${PRODUCTION} from sidebar` }),
    );
    expect(screen.getByText("Hidden (1)")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Restore ${PRODUCTION}` }),
    ).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("sidebar.hidden") ?? "[]")).toEqual([
      id(PRODUCTION),
    ]);
  });

  it("restores a hidden module back to its group", () => {
    localStorage.setItem("sidebar.hidden", JSON.stringify([id(PRODUCTION)]));
    renderLayout();
    expect(
      screen.getByRole("button", { name: `Restore ${PRODUCTION}` }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: `Restore ${PRODUCTION}` }),
    );
    // Hidden section gone; back in its group.
    expect(screen.queryByText("Hidden (1)")).toBeNull();
    expect(JSON.parse(localStorage.getItem("sidebar.hidden") ?? "[]")).toEqual(
      [],
    );
  });

  it("keeps a hidden module out of the Pinned section too", () => {
    localStorage.setItem("sidebar.pins", JSON.stringify([id(TRADING)]));
    localStorage.setItem("sidebar.hidden", JSON.stringify([id(TRADING)]));
    renderLayout();
    // Pinned + hidden → only appears once, in the Hidden section.
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(screen.getAllByRole("link", { name: TRADING })).toHaveLength(1);
  });

  it("badges the Scripts nav entry with the number of running scripts", async () => {
    vi.mocked(invoke).mockImplementation((cmd: unknown) => {
      if (cmd === "scripts_list") {
        return Promise.resolve([
          {
            id: "a",
            name: "Watcher",
            language: "rhai",
            code: "1",
            intervalMin: 5,
            enabled: true,
            updatedAt: 0,
          },
          // Not armed (no interval) — shouldn't count.
          {
            id: "b",
            name: "One-off",
            language: "js",
            code: "1",
            intervalMin: null,
            enabled: false,
            updatedAt: 0,
          },
        ]);
      }
      return Promise.resolve(undefined);
    });
    renderLayout();
    const scriptsLink = await screen.findByRole("link", { name: /scripts/i });
    expect(await within(scriptsLink).findByText("1")).toBeInTheDocument();
  });
});
