import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PluginsPage } from "./PluginsPage";
import type { PluginEntry } from "../../lib/api";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const PLUGIN: PluginEntry = {
  manifest: {
    id: "pricing-model",
    name: "Pricing Model",
    version: "0.1.0",
    minAppVersion: "0.33.0",
    wasm: "pricing_model.wasm",
    permissions: ["sde:read", "storage:own"],
  },
  active: false,
};

function renderPage(entries: PluginEntry[]) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugins_list") return Promise.resolve(entries);
    if (cmd === "plugin_set_active") return Promise.resolve();
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<PluginsPage />, { wrapper });
}

describe("PluginsPage", () => {
  // NB: brace the body — a bare `() => invokeMock.mockReset()` returns the mock
  // fn, which Vitest would treat as a teardown callback and *call* (a spurious
  // zero-arg invoke).
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("lists an installed plugin and the capabilities it declares", async () => {
    renderPage([PLUGIN]);
    expect(await screen.findByText("Pricing Model")).toBeInTheDocument();
    // Declared permissions are shown (human-readable) so the user sees them.
    expect(
      screen.getByText("Read static game data (items, blueprints)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Store its own private data")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });

  it("activating a plugin calls plugin_set_active(id, true)", async () => {
    renderPage([PLUGIN]);
    const button = await screen.findByRole("button", { name: "Activate" });
    fireEvent.click(button);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("plugin_set_active", {
        pluginId: "pricing-model",
        active: true,
      }),
    );
  });

  it("shows an empty state when nothing is installed", async () => {
    renderPage([]);
    expect(
      await screen.findByText(/No plugins installed/i),
    ).toBeInTheDocument();
  });
});
