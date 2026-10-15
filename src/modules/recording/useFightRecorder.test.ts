import { describe, expect, it } from "vitest";
import { substituteHookVars } from "./useFightRecorder";

describe("substituteHookVars", () => {
  it("fills {start}/{end} with the fight's epoch bounds", () => {
    expect(
      substituteHookVars("rec.sh --from {start} --to {end}", {
        start: 1000,
        end: 1065,
      }),
    ).toBe("rec.sh --from 1000 --to 1065");
  });

  it("replaces every occurrence and blanks unknown bounds", () => {
    expect(substituteHookVars("echo {start} {start} {end}", { start: 5 })).toBe(
      "echo 5 5 ",
    );
  });

  it("returns empty for a blank command so callers skip the spawn", () => {
    expect(substituteHookVars("   ", { start: 1 })).toBe("");
  });
});
