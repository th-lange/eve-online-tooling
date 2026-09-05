import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { FeedbackPage } from "./FeedbackPage";
import type { FeedbackEntry, FeedbackStatus } from "../../lib/api";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const READY: FeedbackStatus = {
  configured: true,
  appVersion: "0.57.1",
  uid: "anon-uid-1",
  pending: 0,
  submittedToday: 0,
  cooldownSecs: 0,
};

const SENT: FeedbackEntry = {
  id: "local1",
  docId: "DOC123",
  payload: {
    kind: "rating",
    module: "production",
    rating: 5,
    body: "",
    character: "Some Capsuleer",
    appVersion: "0.57.1",
    os: "linux",
    uid: "anon-uid-1",
  },
  submittedAt: 1_780_000_000,
  status: "sent",
  error: null,
};

/** Record of the arguments the page passed to `feedback_submit`. */
let submitted: Record<string, unknown> | undefined;

function mockBridge(
  status: FeedbackStatus = READY,
  history: FeedbackEntry[] = [],
) {
  submitted = undefined;
  invokeMock.mockImplementation(
    (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "feedback_status":
          return Promise.resolve(status);
        case "feedback_history":
        case "feedback_retry_pending":
          return Promise.resolve(history);
        case "feedback_preview":
          return Promise.resolve({
            kind: args?.kind,
            module: args?.module,
            rating: args?.rating,
            body: args?.body,
            character: args?.attachCharacter ? "Some Capsuleer" : null,
            appVersion: "0.57.1",
            os: "linux",
            uid: "anon-uid-1",
          });
        case "feedback_submit":
          submitted = args;
          return Promise.resolve(SENT);
        case "feedback_forget":
          return Promise.resolve([]);
        default:
          return Promise.reject(new Error(`unexpected command ${cmd}`));
      }
    },
  );
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<FeedbackPage />, { wrapper });
}

beforeEach(() => {
  invokeMock.mockReset();
  mockBridge();
});

describe("FeedbackPage", () => {
  it("offers every registry module plus a general category", () => {
    renderPage();
    const select = screen.getByLabelText(/which part of the app/i);
    const values = [...select.querySelectorAll("option")].map((o) => o.value);
    // "general" is the catch-all; the rest come from the module registry, so a
    // couple of known ids must be present.
    expect(values).toContain("general");
    expect(values).toContain("production");
    expect(values).toContain("faction-warfare");
    // Guards the registry <-> page import cycle: if `modules` were read at
    // module-eval time it would be undefined here and the list would be bare.
    expect(values.length).toBeGreaterThan(5);
  });

  it("won't send a rating until stars are picked", async () => {
    renderPage();
    const send = screen.getByRole("button", { name: /send feedback/i });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));
    await waitFor(() => expect(send).toBeEnabled());
  });

  it("sends the rating, module and character choice the user made", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/which part of the app/i), {
      target: { value: "production" },
    });
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));

    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).toMatchObject({
      kind: "rating",
      module: "production",
      rating: 5,
      attachCharacter: true,
    });
    expect(await screen.findByText(/DOC123/)).toBeInTheDocument();
  });

  it("won't send a bug report with no words", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^bug$/i }));
    const send = screen.getByRole("button", { name: /send feedback/i });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/tell us about it/i), {
      target: { value: "it exploded" },
    });
    await waitFor(() => expect(send).toBeEnabled());
  });

  it("never sends stars on a bug report", async () => {
    renderPage();
    // Pick stars first, then switch kind — the rating must not tag along.
    fireEvent.click(screen.getByRole("button", { name: "5 stars" }));
    fireEvent.click(screen.getByRole("button", { name: /^bug$/i }));
    fireEvent.change(screen.getByLabelText(/tell us about it/i), {
      target: { value: "it exploded" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).toMatchObject({ kind: "bug", rating: 0 });
  });

  it("shows the payload the backend says it will send, character included", async () => {
    renderPage();
    fireEvent.click(screen.getByText(/show exactly what gets sent/i));
    expect(await screen.findByText(/Some Capsuleer/)).toBeInTheDocument();
  });

  it("drops the character from the payload when the user unticks the box", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText(/show exactly what gets sent/i));
    const preview = await screen.findByText(/"character": null/);
    expect(preview).toBeInTheDocument();
  });

  it("explains itself and offers GitHub when the build has no endpoint", async () => {
    mockBridge({ ...READY, configured: false });
    renderPage();
    expect(
      await screen.findByText(/no feedback endpoint configured/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /send feedback/i }),
    ).toBeDisabled();
  });

  it("flushes anything queued when the page opens", async () => {
    mockBridge(READY, []);
    renderPage();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("feedback_retry_pending"),
    );
  });

  it("lists past submissions with their delivery state", async () => {
    mockBridge(READY, [
      SENT,
      {
        ...SENT,
        id: "local2",
        docId: null,
        status: "pending",
        error: "offline",
        payload: { ...SENT.payload, kind: "bug", body: "boom", rating: 0 },
      },
    ]);
    renderPage();
    expect(await screen.findByText("sent")).toBeInTheDocument();
    expect(screen.getByText("queued")).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
  });
});
