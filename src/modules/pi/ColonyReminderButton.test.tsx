import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: vi.fn(),
}));

import { ReminderProvider } from "../reminders/ReminderProvider";
import { ColonyReminderButton } from "./ColonyReminderButton";
import type { ColonyView } from "../../lib/api";

const KEY = "settings.reminders";

const colony: ColonyView = {
  characterId: 1,
  characterName: "Pilot",
  planetId: 40,
  systemId: 30,
  systemName: "Pator",
  planetType: "Barren",
  upgradeLevel: 5,
  pinCount: 12,
  extractors: [
    {
      productTypeId: 2268,
      product: "Aqueous Liquids",
      qtyPerCycle: 3000,
      cycleTime: 3600,
      installTime: "2099-01-01T00:00:00Z",
      expiryTime: "2099-01-02T00:00:00Z",
    },
  ],
  storage: [],
  balance: [],
  produced: [],
  notes: "",
  targetProducts: [],
  needsAttention: false,
};

beforeEach(() => localStorage.clear());

describe("ColonyReminderButton", () => {
  it("opens a form pre-filled from the colony and creates a PI reminder", () => {
    render(
      <ReminderProvider>
        <ColonyReminderButton colony={colony} />
      </ReminderProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remind me" }));

    const what = screen.getByLabelText(
      "What to be reminded about",
    ) as HTMLInputElement;
    expect(what.value).toBe("Pator Barren extraction");
    const date = screen.getByLabelText(
      "Reminder date (YYYY-MM-DD)",
    ) as HTMLInputElement;
    // Pre-filled from the extractor's expiry.
    expect(date.value).not.toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      category: "pi",
      what: "Pator Barren extraction",
    });
    // Confirmation flips the button label briefly.
    expect(
      screen.getByRole("button", { name: "Reminder set ✓" }),
    ).toBeInTheDocument();
  });
});
