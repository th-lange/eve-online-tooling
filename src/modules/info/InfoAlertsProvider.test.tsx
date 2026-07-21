import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InfoAlertsProvider } from "./InfoAlertsProvider";
import { useInfoAlerts } from "./infoContext";
import type { InfoEntry } from "../../lib/api";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function Probe() {
  const { unseen, hasEntries, markSeen } = useInfoAlerts();
  return (
    <div>
      <span data-testid="unseen">{unseen}</span>
      <span data-testid="has-entries">{String(hasEntries)}</span>
      <button onClick={markSeen}>seen</button>
    </div>
  );
}

const ALARM: InfoEntry = {
  id: "a1",
  kind: "alarm",
  text: "boom",
  detail: null,
  source: "script:x",
  at: 1_700_000_000,
};
const MESSAGE: InfoEntry = {
  id: "m1",
  kind: "message",
  text: "note",
  detail: null,
  source: "plugin:y",
  at: 1_700_000_001,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  localStorage.clear();
});

describe("InfoAlertsProvider", () => {
  it("counts unseen alarms and clears them on markSeen", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    // Newest first: one alarm + one message -> unseen alarms = 1.
    qc.setQueryData<InfoEntry[]>(["info"], [MESSAGE, ALARM]);

    render(
      <QueryClientProvider client={qc}>
        <InfoAlertsProvider>
          <Probe />
        </InfoAlertsProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("unseen").textContent).toBe("1");
    expect(screen.getByTestId("has-entries").textContent).toBe("true");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "seen" }));
    });
    // Marking seen clears the unseen counter but the bell stays "lit" —
    // the feed itself still has entries.
    expect(screen.getByTestId("unseen").textContent).toBe("0");
    expect(screen.getByTestId("has-entries").textContent).toBe("true");
  });

  it("reports no entries when the feed is empty", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    qc.setQueryData<InfoEntry[]>(["info"], []);

    render(
      <QueryClientProvider client={qc}>
        <InfoAlertsProvider>
          <Probe />
        </InfoAlertsProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("has-entries").textContent).toBe("false");
  });
});
