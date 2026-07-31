import { describe, expect, it } from "vitest";
import { resolveStartModule } from "./startModule";

describe("resolveStartModule", () => {
  const ids = ["production", "route", "wormholes"];

  it("keeps a stored id the registry still knows", () => {
    expect(resolveStartModule("route", ids, "production")).toBe("route");
  });

  it("falls back when the stored module is gone or absent", () => {
    // A removed/renamed module, or a plugin that is no longer active.
    expect(resolveStartModule("retired-module", ids, "production")).toBe(
      "production",
    );
    expect(resolveStartModule(null, ids, "production")).toBe("production");
  });
});
