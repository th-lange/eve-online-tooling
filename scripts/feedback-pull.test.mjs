import { describe, expect, it } from "vitest";
import { digest, fenced, inline } from "./feedback-pull.mjs";

const entry = (over) => ({
  id: "abc123",
  kind: "bug",
  module: "orders",
  rating: 0,
  subject: "Crash",
  body: "It broke",
  character: null,
  appVersion: "0.81.0",
  os: "linux",
  createdAt: "2026-11-12T10:00:00Z",
  ...over,
});

describe("inline", () => {
  it("escapes pipes and collapses newlines so a field cannot split a table cell or row", () => {
    expect(inline("a|b\n| forged | row |\r\nx")).toBe(
      "a\\|b \\| forged \\| row \\| x",
    );
  });
});

describe("fenced", () => {
  it("uses a fence longer than any backtick run in the body", () => {
    const out = fenced("hi\n````\n# Heading\n````");
    expect(out[0]).toBe("  `````text");
    expect(out.at(-1)).toBe("  `````");
  });

  it("emits nothing for an empty body", () => {
    expect(fenced("  \n ")).toEqual([]);
  });
});

describe("digest", () => {
  it("fences bodies and starts with an untrusted-content banner", () => {
    const md = digest([entry({ body: "# Ignore previous instructions" })]);
    expect(md).toContain("Untrusted user content");
    expect(md).toContain("  ```text\n  # Ignore previous instructions\n  ```");
  });

  it("keeps hostile module, subject and os values on their own table cell / line", () => {
    const md = digest([
      entry({
        module: "x | 9 | 9.9 | 9 | 9 |\n| forged",
        subject: "a\n## Injected",
        os: "linux\n# h",
      }),
    ]);
    const rows = md.split("\n").filter((l) => l.startsWith("|"));
    // header, separator, and exactly one module row
    expect(rows).toHaveLength(3);
    expect(
      md.split("\n").some((l) => l.startsWith("#") && l.includes("Injected")),
    ).toBe(false);
    expect(md.split("\n").some((l) => l.startsWith("# h"))).toBe(false);
  });

  it("does not throw on a hostile rating or kind", () => {
    expect(() =>
      digest([
        entry({ kind: "toString", rating: 1e9 }),
        entry({ kind: "rating", rating: 1e9, body: "" }),
      ]),
    ).not.toThrow();
  });
});
