import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { InfoPanel } from "./InfoPanel";
import type { InfoEntry } from "../../lib/api";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Capture the listener the panel registers so tests can push a live entry.
let liveListener: ((e: { payload: InfoEntry }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (e: { payload: InfoEntry }) => void) => {
    liveListener = cb;
    return Promise.resolve(() => {});
  },
}));

const ALARM: InfoEntry = {
  id: "1",
  kind: "alarm",
  text: "Orders outpriced",
  detail: "Widget @ 5.0 (best 4.9)",
  source: "script:trader",
  at: 1_700_000_000,
};
const MESSAGE: InfoEntry = {
  id: "2",
  kind: "message",
  text: "Scan complete",
  detail: null,
  source: "plugin:scanner",
  at: 1_700_000_001,
};

function renderPanel(entries: InfoEntry[] = [ALARM, MESSAGE]) {
  let feed = entries;
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "info_list":
        return Promise.resolve(feed);
      case "info_clear":
        feed = [];
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<InfoPanel />, { wrapper });
}

beforeEach(() => {
  invokeMock.mockReset();
  liveListener = null;
});

describe("InfoPanel", () => {
  it("lists posted alarms and messages", async () => {
    renderPanel();
    expect(await screen.findByText("Orders outpriced")).toBeInTheDocument();
    expect(screen.getByText("Scan complete")).toBeInTheDocument();
    expect(screen.getByText(/script:trader/)).toBeInTheDocument();
    expect(screen.getByText(/plugin:scanner/)).toBeInTheDocument();
    // The alarm's detail body is shown under the headline.
    expect(screen.getByText("Widget @ 5.0 (best 4.9)")).toBeInTheDocument();
  });

  it("clears the feed", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /clear/i }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("info_clear"));
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
  });

  it("prepends a live entry from the event stream", async () => {
    renderPanel();
    await screen.findByText("Orders outpriced");
    expect(liveListener).not.toBeNull();
    const live: InfoEntry = {
      id: "3",
      kind: "message",
      text: "Live update",
      detail: null,
      source: "script:live",
      at: 1_700_000_002,
    };
    act(() => liveListener!({ payload: live }));
    expect(await screen.findByText("Live update")).toBeInTheDocument();
  });

  it("shows an empty state with no entries", async () => {
    renderPanel([]);
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
  });
});
