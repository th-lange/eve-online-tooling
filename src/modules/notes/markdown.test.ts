import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "./markdown";

describe("markdown", () => {
  it("never makes non-web links clickable", () => {
    const [js] = parseInline("[x](javascript:alert(1))");
    expect(js).toEqual({ t: "text", text: "x" });
    const [ok] = parseInline("[site](https://example.com/a)");
    expect(ok).toMatchObject({ t: "a", href: "https://example.com/a" });
  });

  it("keeps raw HTML as literal text", () => {
    const blocks = parseBlocks("<img src=x onerror=alert(1)>");
    expect(blocks).toEqual([
      {
        t: "p",
        lines: [[{ t: "text", text: "<img src=x onerror=alert(1)>" }]],
      },
    ]);
  });

  it("does not italicise snake_case words but does italicise real emphasis", () => {
    expect(parseInline("a_b_c")).toEqual([{ t: "text", text: "a_b_c" }]);
    expect(parseInline("_hi_ and *there*")).toMatchObject([
      { t: "i" },
      { t: "text", text: " and " },
      { t: "i" },
    ]);
  });

  it("parses block structure: headings, lists, tasks, quotes, fences", () => {
    const blocks = parseBlocks(
      [
        "# Title",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "1. one",
        "2. two",
        "",
        "> quoted *text*",
        "",
        "```",
        "# not a heading",
        "```",
        "---",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.t)).toEqual([
      "h",
      "ul",
      "ol",
      "quote",
      "code",
      "hr",
    ]);
    expect(blocks[1]).toMatchObject({
      items: [{ checked: true }, { checked: false }],
    });
    expect(blocks[4]).toEqual({ t: "code", text: "# not a heading" });
  });

  it("keeps single newlines inside a paragraph as separate lines", () => {
    const [p] = parseBlocks("one\ntwo");
    if (p.t !== "p") throw new Error("expected a paragraph");
    expect(p.lines).toHaveLength(2);
  });
});
