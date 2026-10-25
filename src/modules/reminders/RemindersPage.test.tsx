import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const sendNotificationMock = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

import { ReminderProvider } from "./ReminderProvider";
import { RemindersPage } from "./RemindersPage";
import type { Reminder } from "./reminders";

const KEY = "settings.reminders";

function seed(reminders: Reminder[]) {
  localStorage.setItem(KEY, JSON.stringify(reminders));
}

function renderApp() {
  return render(
    <ReminderProvider>
      <RemindersPage />
    </ReminderProvider>,
  );
}

const reminder = (over: Partial<Reminder>): Reminder => ({
  id: "r1",
  category: "pi",
  what: "Pator colony extraction",
  note: "",
  dueAt: Date.now() + 3_600_000,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  sendNotificationMock.mockReset();
});

describe("Reminders — editor", () => {
  it("adds a reminder and lists it, persisted to storage", () => {
    renderApp();

    fireEvent.change(screen.getByLabelText("What to be reminded about"), {
      target: { value: "Invention batch done" },
    });
    fireEvent.change(screen.getByLabelText("Reminder date (YYYY-MM-DD)"), {
      target: { value: "2099-01-01" },
    });
    fireEvent.change(screen.getByLabelText("Reminder time (HH:MM)"), {
      target: { value: "12:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));

    expect(screen.getByText("Invention batch done")).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].dueAt).toBe(new Date("2099-01-01T12:00").getTime());
  });

  it("rejects an empty description", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    expect(
      screen.getByText("Give the reminder a short description."),
    ).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(0);
  });
});

describe("Reminders — firing", () => {
  it("surfaces an already-due reminder on startup and fires a notification", async () => {
    seed([reminder({ dueAt: Date.now() - 60_000, note: "Extractors idle" })]);
    renderApp();

    const dialog = await screen.findByRole("alertdialog", {
      name: "Reminders due",
    });
    expect(dialog).toHaveTextContent("Pator colony extraction");
    expect(dialog).toHaveTextContent("Extractors idle");
    await waitFor(() =>
      expect(sendNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Reminder: Pator colony extraction" }),
      ),
    );
  });

  it("does not surface a reminder whose time hasn't come", async () => {
    seed([reminder({ dueAt: Date.now() + 3_600_000 })]);
    renderApp();

    // Give the mount check a tick to run.
    await Promise.resolve();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("'Done' clears a surfaced reminder and closes the modal", async () => {
    seed([reminder({ dueAt: Date.now() - 60_000 })]);
    renderApp();

    await screen.findByRole("alertdialog", { name: "Reminders due" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(0);
  });
});
