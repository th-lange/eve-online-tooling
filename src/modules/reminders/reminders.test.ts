import { describe, expect, it } from "vitest";
import {
  dueReminders,
  formatWhen,
  fromDatetimeLocal,
  sortByDue,
  toDatetimeLocal,
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
