import { describe, expect, it } from "vitest";
import {
  advance,
  dueReminders,
  formatRepeat,
  formatWhen,
  fromDatetimeLocal,
  reminderTarget,
  sortByDue,
  toDatetimeLocal,
  toRepeat,
  type Reminder,
} from "./reminders";

const r = (id: string, dueAt: number): Reminder => ({
  id,
  category: "pi",
  what: id,
  note: "",
  dueAt,
});

describe("dueReminders", () => {
  it("returns only reminders at/before now, earliest first", () => {
    const now = 1_000;
    const list = [r("late", 2_000), r("due", 500), r("exactly-now", 1_000)];
    expect(dueReminders(list, now).map((x) => x.id)).toEqual([
      "due",
      "exactly-now",
    ]);
  });

  it("is empty when nothing is due", () => {
    expect(dueReminders([r("future", 5_000)], 1_000)).toEqual([]);
  });
});

describe("sortByDue", () => {
  it("orders by due time without mutating the input", () => {
    const list = [r("c", 300), r("a", 100), r("b", 200)];
    expect(sortByDue(list).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(list.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
});

describe("formatWhen", () => {
  const now = 0;
  it("renders future and past at the coarsest sensible unit", () => {
    expect(formatWhen(5 * 60_000, now)).toBe("in 5m");
    expect(formatWhen(-2 * 3_600_000, now)).toBe("2h ago");
    expect(formatWhen(3 * 86_400_000, now)).toBe("in 3d");
  });
  it("renders sub-minute deltas as 'now'", () => {
    expect(formatWhen(30_000, now)).toBe("now");
    expect(formatWhen(-10_000, now)).toBe("now");
  });
});

describe("datetime-local round trip", () => {
  it("survives to the minute", () => {
    // A fixed local wall-clock time, seconds/millis stripped.
    const base = new Date(2026, 4, 17, 9, 35, 0, 0).getTime();
    expect(fromDatetimeLocal(toDatetimeLocal(base))).toBe(base);
  });

  it("flags an unparseable value as NaN", () => {
    expect(Number.isNaN(fromDatetimeLocal("not a date"))).toBe(true);
  });
});

const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;

describe("advance (repeating reminders)", () => {
  it("rolls forward one period when the due time just passed", () => {
    expect(advance(1000, 100, 1050)).toBe(1100);
  });
  it("skips periods missed while the app was closed, landing in the future", () => {
    expect(advance(0, 100, 350)).toBe(400);
  });
  it("advances by a period even from a still-future due time", () => {
    expect(advance(1000, 100, 500)).toBe(1100);
  });
});

describe("toRepeat / formatRepeat", () => {
  it("picks the largest exact unit", () => {
    expect(toRepeat(6 * DAY)).toEqual({ n: 6, unit: "days" });
    expect(toRepeat(2 * WEEK)).toEqual({ n: 2, unit: "weeks" });
    expect(toRepeat(3 * 60 * 60_000)).toEqual({ n: 3, unit: "hours" });
  });
  it("renders a compact label", () => {
    expect(formatRepeat(6 * DAY)).toBe("every 6d");
    expect(formatRepeat(2 * WEEK)).toBe("every 2w");
  });
});

describe("reminderTarget", () => {
  const base = (over: Partial<Reminder>): Reminder => ({
    id: "x",
    category: "other",
    what: "w",
    note: "",
    dueAt: 0,
    ...over,
  });
  it("maps categories to their default module", () => {
    expect(reminderTarget(base({ category: "pi" }))).toEqual({
      moduleId: "pi",
    });
    expect(reminderTarget(base({ category: "production" }))).toEqual({
      moduleId: "production",
    });
    expect(reminderTarget(base({ category: "invention" }))).toEqual({
      moduleId: "industry-jobs",
    });
    expect(reminderTarget(base({ category: "other" }))).toBeNull();
  });
  it("prefers an explicit link (e.g. a PI colony)", () => {
    expect(
      reminderTarget(
        base({ category: "pi", link: { moduleId: "pi", planetId: 42 } }),
      ),
    ).toEqual({ moduleId: "pi", planetId: 42 });
  });
});
