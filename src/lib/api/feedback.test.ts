import { describe, expect, it } from "vitest";
import { githubIssueUrl } from "./feedback";

describe("githubIssueUrl", () => {
  it("routes a bug to the bug template and carries the version", () => {
    const url = new URL(
      githubIssueUrl(
        { kind: "bug", module: "production", body: "it crashed" },
        "0.57.1",
        "Production",
      ),
    );
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("version")).toBe("0.57.1");
    expect(url.searchParams.get("what_happened")).toContain("it crashed");
    // The module survives in the body because the template's `area` field is a
    // dropdown that would silently reject a registry id.
    expect(url.searchParams.get("what_happened")).toContain(
      "Module: Production",
    );
    expect(url.searchParams.has("area")).toBe(false);
  });

  it("routes a feature request to the feature template", () => {
    const url = new URL(
      githubIssueUrl(
        { kind: "feature", module: "general", body: "dark mode" },
        "0.57.1",
        "General",
      ),
    );
    expect(url.searchParams.get("template")).toBe("feature_request.yml");
    expect(url.searchParams.get("problem")).toContain("dark mode");
    // The feature template has no version field; sending one would be ignored.
    expect(url.searchParams.has("version")).toBe(false);
  });

  it("survives an empty body", () => {
    const url = new URL(
      githubIssueUrl(
        { kind: "bug", module: "general", body: "" },
        "1.0.0",
        "General",
      ),
    );
    expect(url.searchParams.get("what_happened")).toBe("Module: General");
  });
});
