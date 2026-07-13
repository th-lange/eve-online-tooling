import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ScriptsPage } from "./ScriptsPage";
import type { Script, ScriptRun, ExampleScript } from "../../lib/api";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// CodeMirror needs real layout; swap it for a plain textarea in tests so the
// page's behavior (not the editor internals) is what's exercised.
vi.mock("./CodeEditor", () => ({
  CodeEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <textarea
      aria-label="code"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const SCRIPT: Script = {
  id: "greeter",
  name: "Greeter",
  language: "rhai",
  code: "40 + 2",
  intervalMin: null,
  enabled: false,
  updatedAt: 1,
};

const RUNNING: Script = {
  id: "ticker",
  name: "Ticker",
  language: "rhai",
  code: "1",
  intervalMin: 5,
  enabled: true,
  updatedAt: 2,
};

const RUN_OK: ScriptRun = {
  ok: true,
  result: 42,
  logs: ["hello"],
  error: null,
  durationMs: 3,
};

const EXAMPLES: ExampleScript[] = [
  {
    id: "outpriced-rhai",
    name: "Outpriced order alert (Rhai)",
    language: "rhai",
    code: "my_orders()",
  },
];

function renderPage(scripts: Script[] = [SCRIPT]) {
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "scripts_list":
        return Promise.resolve(scripts);
      case "scripts_run":
        return Promise.resolve(RUN_OK);
      case "scripts_save":
        return Promise.resolve(scripts);
      case "scripts_delete":
        return Promise.resolve([]);
      case "scripts_examples":
        return Promise.resolve(EXAMPLES);
      default:
        return Promise.resolve(undefined);
    }
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ScriptsPage />, { wrapper });
}

beforeEach(() => invokeMock.mockReset());

describe("ScriptsPage", () => {
  it("lists stored scripts", async () => {
    renderPage();
    expect(await screen.findByText("Greeter")).toBeInTheDocument();
  });

  it("opens a script in the editor when selected", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Greeter"));
    expect(await screen.findByDisplayValue("Greeter")).toBeInTheDocument();
    expect(screen.getByDisplayValue("40 + 2")).toBeInTheDocument();
  });

  it("runs the editor's code and shows the result and logs", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Greeter"));
    fireEvent.click(await screen.findByRole("button", { name: /run/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scripts_run", {
        args: { code: "40 + 2", language: "rhai" },
      }),
    );
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  it("saves the edited script", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Greeter"));
    fireEvent.click(await screen.findByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(([cmd]) => cmd === "scripts_save"),
      ).toBe(true),
    );
  });

  it("creates a blank draft with New script", async () => {
    renderPage([]);
    fireEvent.click(await screen.findByRole("button", { name: /new script/i }));
    expect(await screen.findByDisplayValue("New script")).toBeInTheDocument();
  });

  it("deletes the selected script", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Greeter"));
    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scripts_delete", {
        id: "greeter",
      }),
    );
  });

  it("loads a bundled example from the collapsible Examples section", async () => {
    renderPage();
    await screen.findByText("Greeter");
    // Collapsed by default: the example isn't shown yet.
    expect(
      screen.queryByText("Outpriced order alert (Rhai)"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^examples$/i }));
    const example = await screen.findByText("Outpriced order alert (Rhai)");
    fireEvent.click(example);
    // The example's name + code land in the editor.
    expect(
      await screen.findByDisplayValue("Outpriced order alert (Rhai)"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("my_orders()")).toBeInTheDocument();
  });

  it("stops a running script's loop from the list", async () => {
    renderPage([RUNNING]);
    // A running script shows a Stop control.
    const stop = await screen.findByRole("button", { name: /stop the loop/i });
    fireEvent.click(stop);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("scripts_save", {
        script: expect.objectContaining({ id: "ticker", enabled: false }),
      }),
    );
  });
});
