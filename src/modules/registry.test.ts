import { describe, expect, it } from "vitest";
import { modules } from "./registry";

describe("module registry", () => {
  it("registers the production module", () => {
    const ids = modules.map((m) => m.id);
    expect(ids).toContain("production");
  });

  it("registers the fitting module", () => {
    const ids = modules.map((m) => m.id);
    expect(ids).toContain("fitting");
  });

  it("gives every module a unique id, title and component", () => {
    const ids = modules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of modules) {
      expect(m.id).toBeTruthy();
      expect(m.title).toBeTruthy();
      expect(typeof m.Component).toBe("function");
    }
  });
});
