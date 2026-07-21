import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PluginsPage } from "./PluginsPage";
import type { McpStatus, PluginEntry } from "../../lib/api";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Capture the registered drag-drop handler so tests can fire synthetic
// enter/drop/leave events, the same shape Tauri's native webview sends.
let dragDropHandler: ((event: { payload: unknown }) => void) | null = null;
const unlistenMock = vi.fn();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: { payload: unknown }) => void) => {
      dragDropHandler = handler;
      return Promise.resolve(unlistenMock);
    },
  }),
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
  let autostart = false;
  let devTier = false;
  invokeMock.mockImplementation(
    (
      cmd: string,
      args?: { port?: number; autostart?: boolean; devTier?: boolean },
    ) => {
      switch (cmd) {
        case "plugins_list":
          return Promise.resolve(entries);
        case "plugins_set_active":
          return Promise.resolve();
        case "mcp_status":
          return Promise.resolve(mcp);
        case "mcp_config":
          return Promise.resolve({ port: 0, autostart, devTier });
        case "mcp_start":
          mcp = RUNNING;
          return Promise.resolve(mcp);
        case "mcp_stop":
          mcp = STOPPED;
          return Promise.resolve(mcp);
        case "mcp_set_port":
          return Promise.resolve(mcp);
        case "mcp_set_autostart":
          autostart = args?.autostart ?? false;
          return Promise.resolve({ port: 0, autostart, devTier });
        case "mcp_set_dev_tier":
          devTier = args?.devTier ?? false;
          return Promise.resolve({ port: 0, autostart, devTier });
        case "plugins_dir":
          return Promise.resolve("/tmp/app/plugins");
        case "plugins_rescan":
          return Promise.resolve(entries);
        case "plugins_install":
          return Promise.resolve(entries);
        case "plugins_remove":
          return Promise.resolve(entries.filter((e) => e !== PLUGIN));
        default:
          return Promise.reject(
            new Error(`unexpected command ${cmd} ${JSON.stringify(args)}`),
          );
      }
    },
  );
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
    dragDropHandler = null;
    unlistenMock.mockReset();
    localStorage.clear();
  });

  it("lists an installed plugin and the capabilities it declares", async () => {
    renderPage([PLUGIN]);
    expect(await screen.findByText("Pricing Model")).toBeInTheDocument();
    expect(
      screen.getByText("Read static game data (items, blueprints)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Store its own private data")).toBeInTheDocument();
  });

  it("activating a plugin calls plugins_set_active(id, true)", async () => {
    renderPage([PLUGIN]);
    const card = await screen.findByText("Pricing Model");
    const button = within(
      card.closest("div.rounded-lg") as HTMLElement,
    ).getByRole("button", { name: "Activate" });
    fireEvent.click(button);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("plugins_set_active", {
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

  it("collapses the MCP bridge card, hiding config, even while active", async () => {
    renderPage([], RUNNING);
    await screen.findByText("MCP bridge");
    const card = pluginCard("MCP bridge");
    // Active, connection details visible, header still shows Deactivate.
    expect(
      await within(card).findByText(RUNNING.url as string),
    ).toBeInTheDocument();
    within(card).getByRole("button", { name: "Deactivate" });

    const toggle = within(card).getByRole("button", { name: /mcp bridge/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Config controls and connection details collapse away...
    expect(within(card).queryByText(RUNNING.url as string)).toBeNull();
    expect(
      within(card).queryByRole("checkbox", {
        name: /start mcp bridge on launch/i,
      }),
    ).toBeNull();
    // ...but the header — including Deactivate — stays usable.
    within(card).getByRole("button", { name: "Deactivate" });
    expect(within(card).getByText("Active")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      await within(card).findByText(RUNNING.url as string),
    ).toBeInTheDocument();
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

  it("toggling autostart calls mcp_set_autostart and persists checked state", async () => {
    renderPage([]);
    await screen.findByText("MCP bridge");
    const card = pluginCard("MCP bridge");
    const checkbox = within(card).getByRole("checkbox", {
      name: /start mcp bridge on launch/i,
    });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("mcp_set_autostart", {
        autostart: true,
      }),
    );
    await waitFor(() => expect(checkbox).toBeChecked());
  });

  it("toggling the dev-tier checkbox calls mcp_set_dev_tier and persists checked state", async () => {
    renderPage([]);
    await screen.findByText("MCP bridge");
    const card = pluginCard("MCP bridge");
    const checkbox = within(card).getByRole("checkbox", {
      name: /expose compute engines to mcp/i,
    });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("mcp_set_dev_tier", {
        devTier: true,
      }),
    );
    await waitFor(() => expect(checkbox).toBeChecked());
  });

  it("shows the plugins folder path and Rescan calls plugins_rescan", async () => {
    renderPage([]);
    expect(await screen.findByText("/tmp/app/plugins")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("plugins_rescan"),
    );
  });

  it("dropping a path installs it and shows the fresh list", async () => {
    renderPage([]);
    await screen.findByText("/tmp/app/plugins");
    expect(dragDropHandler).not.toBeNull();
    act(() => {
      dragDropHandler?.({
        payload: {
          type: "drop",
          paths: ["/home/user/Downloads/pricing-model"],
        },
      });
    });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("plugins_install", {
        path: "/home/user/Downloads/pricing-model",
      }),
    );
  });

  it("hovering a drag shows the drop hint, leaving clears it", async () => {
    renderPage([]);
    await screen.findByText("/tmp/app/plugins");
    expect(dragDropHandler).not.toBeNull();
    act(() => {
      dragDropHandler?.({
        payload: { type: "enter", paths: [], position: {} },
      });
    });
    expect(await screen.findByText("Drop to install…")).toBeInTheDocument();
    act(() => {
      dragDropHandler?.({ payload: { type: "leave" } });
    });
    await waitFor(() =>
      expect(screen.queryByText("Drop to install…")).toBeNull(),
    );
  });

  it("removing a plugin requires confirmation before calling plugins_remove", async () => {
    renderPage([PLUGIN]);
    await screen.findByText("Pricing Model");
    const card = pluginCard("Pricing Model");
    fireEvent.click(within(card).getByRole("button", { name: /remove/i }));
    // Not called yet — the first click only asks for confirmation.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "plugins_remove",
      expect.anything(),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("plugins_remove", {
        pluginId: "pricing-model",
      }),
    );
  });

  it("cancelling a remove leaves the plugin installed", async () => {
    renderPage([PLUGIN]);
    await screen.findByText("Pricing Model");
    const card = pluginCard("Pricing Model");
    fireEvent.click(within(card).getByRole("button", { name: /remove/i }));
    fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(invokeMock).not.toHaveBeenCalledWith(
      "plugins_remove",
      expect.anything(),
    );
    expect(screen.getByText("Pricing Model")).toBeInTheDocument();
  });
});
