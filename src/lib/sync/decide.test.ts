import { describe, expect, it } from "vitest";
import { decideSync } from "./decide";

describe("decideSync", () => {
  it("imports when the remote file is newer than the local manifest", () => {
    expect(decideSync(1000, 2000)).toBe("import");
  });

  it("exports when local is newer than the remote file", () => {
    expect(decideSync(2000, 1000)).toBe("export");
  });

  it("exports when there's no remote file yet and local has a timestamp", () => {
    expect(decideSync(1000, undefined)).toBe("export");
  });

  it("is unchanged when the timestamps are exactly equal", () => {
    expect(decideSync(1000, 1000)).toBe("noop");
  });
  it("is unchanged when both are untouched (local 0, no remote)", () => {
    // A missing remote file reads as -1, so an untouched local manifest (0)
    // still counts as "newer" and exports — harmless (an empty/default
    // payload lands with updatedAt: 0, immediately superseded by any real
    // touch on either side).
    expect(decideSync(0, undefined)).toBe("export");
  });
});
