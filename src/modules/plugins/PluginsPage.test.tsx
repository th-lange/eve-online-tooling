import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PluginsPage } from "./PluginsPage";
import type { McpStatus, PluginEntry } from "../../lib/api";

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

const RUNNING: McpStatus = {
  running: true,
  url: "http://127.0.0.1:54321/mcp",
  token: "test-token-abc",
};
const STOPPED: McpStatus = { running: false, url: null, token: null };

function renderPage(entries: PluginEntry[], mcpStart: McpStatus = STOPPED) {
  // Stateful MCP mock: start/stop flip what status returns next.
  let mcp: McpStatus = mcpStart;
  invokeMock.mockImplementation((cmd: string, args?: { port?: number }) => {
    switch (cmd) {
      case "plugins_list":
        return Promise.resolve(entries);
      case "plugin_set_active":
        return Promise.resolve();
      case "mcp_status":
        return Promise.resolve(mcp);
      case "mcp_config":
        return Promise.resolve({ port: 0 });
      case "mcp_start":
        mcp = RUNNING;
        return Promise.resolve(mcp);
      case "mcp_stop":
        mcp = STOPPED;
        return Promise.resolve(mcp);
      case "mcp_set_port":
        return Promise.resolve(mcp);
      case "plugins_dir":
        return Promise.resolve("/tmp/app/plugins");
      case "plugins_rescan":
        return Promise.resolve(entries);
      default:
        return Promise.reject(
          new Error(`unexpected command ${cmd} ${JSON.stringify(args)}`),
        );
    }
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<PluginsPage />, { wrapper });
}

/** The plugin's card (scoped so its button doesn't collide with the bridge). */
function pluginCard(name: string): HTMLElement {
  return screen.getByText(name).closest("div.rounded-lg") as HTMLElement;
}

describe("PluginsPage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("lists an installed plugin and the capabilities it declares", async () => {
    renderPage([PLUGIN]);
    expect(await screen.findByText("Pricing Model")).toBeInTheDocument();
    expect(
      screen.getByText("Read static game data (items, blueprints)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Store its own private data")).toBeInTheDocument();
  });

  it("activating a plugin calls plugin_set_active(id, true)", async () => {
    renderPage([PLUGIN]);
    const card = await screen.findByText("Pricing Model");
    const button = within(
      card.closest("div.rounded-lg") as HTMLElement,
    ).getByRole("button", { name: "Activate" });
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

  it("shows the MCP bridge inactive by default with no token", async () => {
    renderPage([]);
    expect(await screen.findByText("MCP bridge")).toBeInTheDocument();
    const card = pluginCard("MCP bridge");
    expect(within(card).getByText("Inactive")).toBeInTheDocument();
    // No token/url surfaced while inactive.
    expect(screen.queryByText("Token")).toBeNull();
    expect(screen.queryByText("URL")).toBeNull();
  });

  it("activating the MCP bridge calls mcp_start and reveals url + token", async () => {
    renderPage([]);
    await screen.findByText("MCP bridge");
    const card = pluginCard("MCP bridge");
    fireEvent.click(within(card).getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("mcp_start"));
    // After activation the connection details appear.
    expect(await screen.findByText(RUNNING.url as string)).toBeInTheDocument();
    expect(screen.getByText(RUNNING.token as string)).toBeInTheDocument();
  });

  it("setting a port calls mcp_set_port", async () => {
    renderPage([]);
    await screen.findByText("MCP bridge");
    const card = pluginCard("MCP bridge");
    const input = within(card).getByPlaceholderText("auto");
    fireEvent.change(input, { target: { value: "8477" } });
    fireEvent.click(within(card).getByRole("button", { name: "Set" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("mcp_set_port", { port: 8477 }),
    );
  });

  it("shows the plugins folder path and Rescan calls plugins_rescan", async () => {
    renderPage([]);
    expect(await screen.findByText("/tmp/app/plugins")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("plugins_rescan"),
    );
  });
});
