import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginEntry } from "../../lib/api";

// The sidebar's children reach into the Tauri bridge; `plugins_list` returns
// our fixtures, everything else resolves to nothing so the shell still renders.
const entries: PluginEntry[] = [
  {
    manifest: {
      id: "notes",
      name: "Notes",
      version: "1.0.0",
      minAppVersion: "0.36.0",
      ui: "index.html",
      permissions: [],
    },
    active: true,
  },
  {
    // Active but UI-less (WASM-only) — must NOT appear as a nav module.
    manifest: {
      id: "pricer",
      name: "Pricer",
      version: "1.0.0",
      minAppVersion: "0.36.0",
      wasm: "p.wasm",
      permissions: [],
    },
    active: true,
  },
  {
    // A UI plugin that is not activated — inert, so no nav entry.
    manifest: {
      id: "hidden",
      name: "Hidden",
      version: "1.0.0",
      minAppVersion: "0.36.0",
      ui: "index.html",
      permissions: [],
    },
    active: false,
  },
];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "plugins_list"
      ? Promise.resolve(entries)
      : Promise.resolve(undefined),
  ),
}));

import { Layout } from "../../components/Layout";

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Layout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("plugin UI modules", () => {
  it("shows an active UI plugin as a nav entry", async () => {
    renderAt("/");
    expect(
      await screen.findByRole("link", { name: "Notes" }),
    ).toBeInTheDocument();
  });

  it("hides WASM-only and inactive plugins from the nav", async () => {
    renderAt("/");
    // Wait for the active UI plugin to appear, then assert the others don't.
    await screen.findByRole("link", { name: "Notes" });
    expect(screen.queryByRole("link", { name: "Pricer" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Hidden" })).toBeNull();
  });

  it("renders the plugin's UI in a sandboxed iframe at its route", async () => {
    renderAt("/notes");
    const frame = (await screen.findByTitle(
      "plugin-notes",
    )) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(
      "plugin://localhost/notes/index.html",
    );
    // No `allow-same-origin` — the frame stays cross-origin to the app.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });
});
