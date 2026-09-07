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

const ROSTER = [
  { characterId: 1, name: "Some Capsuleer", scopes: [] },
  { characterId: 2, name: "Alt Toon", scopes: [] },
];

const READY: FeedbackStatus = {
  configured: true,
  active: true,
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
  roster: typeof ROSTER = ROSTER,
) {
  submitted = undefined;
  invokeMock.mockImplementation(
    (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "feedback_status":
          return Promise.resolve(status);
        case "auth_characters":
          return Promise.resolve(roster);
        case "auth_active_character":
          return Promise.resolve(roster[0]?.characterId ?? null);
        case "feedback_history":
        case "feedback_retry_pending":
          return Promise.resolve(history);
        case "feedback_preview":
          return Promise.resolve({
            kind: args?.kind,
            module: args?.module,
            rating: args?.rating,
            body: args?.body,
            character:
              roster.find((c) => c.characterId === args?.characterId)?.name ??
              null,
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
    // The reply-to defaults to the active character, so wait for the roster.
    await screen.findByRole("option", { name: "Some Capsuleer" });
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
      // The active character is the default reply-to.
      characterId: 1,
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
    await screen.findByRole("option", { name: "Some Capsuleer" });
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

  it("lets the user be reachable as any of their characters", async () => {
    renderPage();
    await screen.findByRole("option", { name: "Some Capsuleer" });
    const picker = screen.getByLabelText(/reply to me as/i);
    const names = [...picker.querySelectorAll("option")].map((o) => o.text);
    expect(names).toContain("Some Capsuleer");
    expect(names).toContain("Alt Toon");

    fireEvent.change(picker, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).toMatchObject({ characterId: 2 });
  });

  it("sends no character at all when the user picks anonymous", async () => {
    renderPage();
    await screen.findByRole("option", { name: "Some Capsuleer" });
    fireEvent.change(screen.getByLabelText(/reply to me as/i), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByText(/show exactly what gets sent/i));
    expect(await screen.findByText(/"character": null/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).toMatchObject({ characterId: null });
  });

  it("says the module is inactive when no character is registered", async () => {
    mockBridge({ ...READY, active: false }, [], []);
    renderPage();
    expect(
      await screen.findByText(/module inactive — registered account required/i),
    ).toBeInTheDocument();
    // No way to submit anything from this state.
    expect(
      screen.queryByRole("button", { name: /send feedback/i }),
    ).not.toBeInTheDocument();
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
