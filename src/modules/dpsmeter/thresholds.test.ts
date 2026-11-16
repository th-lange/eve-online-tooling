import { describe, expect, it } from "vitest";
import { levelFor, INCOMING_ALARM } from "./thresholds";

describe("levelFor", () => {
  it("has no level without thresholds", () => {
    expect(levelFor(5000, undefined)).toBe("normal");
    expect(levelFor(5000, [])).toBe("normal");
  });

  it("counts a value exactly on a threshold as crossed", () => {
    const steps = INCOMING_ALARM.dpsIn!;
    expect(levelFor(299.9, steps)).toBe("normal");
    expect(levelFor(300, steps)).toBe("warn");
    expect(levelFor(799.9, steps)).toBe("warn");
    expect(levelFor(800, steps)).toBe("danger");
  });

  it("takes the highest threshold reached, whatever order they come in", () => {
    const unsorted = [
      { atOrAbove: 800, level: "danger" as const },
      { atOrAbove: 100, level: "warn" as const },
      { atOrAbove: 400, level: "warn" as const },
    ];
    expect(levelFor(50, unsorted)).toBe("normal");
    expect(levelFor(500, unsorted)).toBe("warn");
    expect(levelFor(900, unsorted)).toBe("danger");
  });

  it("ignores a lower danger step once a higher warn step is reached", () => {
    // A user can configure anything; the highest reached step decides, so a
    // warn above a danger genuinely means "calm down again".
    const odd = [
      { atOrAbove: 100, level: "danger" as const },
      { atOrAbove: 500, level: "warn" as const },
    ];
    expect(levelFor(600, odd)).toBe("warn");
  });
});
