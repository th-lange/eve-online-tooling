import { describe, expect, it } from "vitest";
import { githubIssueUrl } from "./feedback";

describe("githubIssueUrl", () => {
  it("routes a bug to the bug template, carries the version and subject title", () => {
    const url = new URL(
      githubIssueUrl(
        {
          kind: "bug",
          module: "production",
          subject: "Crash on export",
          body: "it crashed",
        },
        "0.57.1",
        "Production",
      ),
    );
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("version")).toBe("0.57.1");
    // The subject becomes the issue title.
    expect(url.searchParams.get("title")).toBe("Crash on export");
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
        {
          kind: "feature",
          module: "general",
          subject: "Dark mode",
          body: "please add it",
        },
        "0.57.1",
        "General",
      ),
    );
    expect(url.searchParams.get("template")).toBe("feature_request.yml");
    expect(url.searchParams.get("problem")).toContain("please add it");
    expect(url.searchParams.get("title")).toBe("Dark mode");
    // The feature template has no version field; sending one would be ignored.
    expect(url.searchParams.has("version")).toBe(false);
  });

  it("omits the title and survives an empty subject and body", () => {
    const url = new URL(
      githubIssueUrl(
        { kind: "bug", module: "general", subject: "", body: "" },
        "1.0.0",
        "General",
      ),
    );
    expect(url.searchParams.get("what_happened")).toBe("Module: General");
    expect(url.searchParams.has("title")).toBe(false);
  });
});
