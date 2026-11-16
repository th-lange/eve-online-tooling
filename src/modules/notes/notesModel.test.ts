import { describe, expect, it } from "vitest";
import type { NoteEntry } from "../../lib/api";
import {
  buildFolderTree,
  collectTags,
  folderOptions,
  isWithin,
  notesInFolder,
  notesWithTag,
  sortNotes,
} from "./notesModel";

function note(over: Partial<NoteEntry> & { path: string }): NoteEntry {
  const file = over.path.slice(over.path.lastIndexOf("/") + 1);
  return {
    name: file.replace(/\.[^.]+$/, ""),
    kind: "markdown",
    folder: over.path.includes("/")
      ? over.path.slice(0, over.path.lastIndexOf("/"))
      : "",
    tags: [],
    updatedAt: 0,
    size: 0,
    ...over,
  };
}

describe("notesModel", () => {
  it("sorts by text (case-insensitive, natural numbers) and by number, both directions", () => {
    const notes = [
      note({ path: "b.md", updatedAt: 5 }),
      note({ path: "a10.md", updatedAt: 9 }),
      note({ path: "A2.md", updatedAt: 1 }),
    ];
    expect(sortNotes(notes, "name", "asc").map((n) => n.name)).toEqual([
      "A2",
      "a10",
      "b",
    ]);
    expect(sortNotes(notes, "updatedAt", "desc").map((n) => n.name)).toEqual([
      "a10",
      "b",
      "A2",
    ]);
    // Input is not mutated.
    expect(notes[0].name).toBe("b");
  });

  it("builds a nested tree, counts direct notes, and recovers missing parents", () => {
    const notes = [
      note({ path: "x.md" }),
      note({ path: "A/B/deep.md" }),
      note({ path: "A/one.md" }),
      note({ path: "A/two.md" }),
    ];
    // "A" is deliberately absent from the folder list.
    const root = buildFolderTree(["A/B", "C"], notes);
    expect(root.noteCount).toBe(1);
    expect(root.children.map((c) => c.path)).toEqual(["A", "C"]);
    const a = root.children[0];
    expect(a.noteCount).toBe(2);
    expect(a.children[0]).toMatchObject({
      path: "A/B",
      name: "B",
      noteCount: 1,
    });
  });

  it("filters by direct folder membership (not descendants) and by tag", () => {
    const notes = [
      note({ path: "a.md", tags: ["x"] }),
      note({ path: "F/b.md", tags: ["x", "y"] }),
      note({ path: "F/G/c.md" }),
    ];
    expect(notesInFolder(notes, "F").map((n) => n.path)).toEqual(["F/b.md"]);
    expect(notesInFolder(notes, "").map((n) => n.path)).toEqual(["a.md"]);
    expect(notesInFolder(notes, null)).toHaveLength(3);
    expect(notesWithTag(notes, "y").map((n) => n.path)).toEqual(["F/b.md"]);
  });

  it("counts tags most-used first", () => {
    const notes = [
      note({ path: "a.md", tags: ["b", "a"] }),
      note({ path: "b.md", tags: ["b"] }),
    ];
    expect(collectTags(notes)).toEqual([
      { tag: "b", count: 2 },
      { tag: "a", count: 1 },
    ]);
  });

  it("isWithin matches whole path components only", () => {
    expect(isWithin("A/B", "A")).toBe(true);
    expect(isWithin("A", "A")).toBe(true);
    expect(isWithin("AB", "A")).toBe(false);
  });

  it("lists the root first, then folders indented by depth", () => {
    const opts = folderOptions(["B", "A", "A/x"]);
    expect(opts.map((o) => o.path)).toEqual(["", "A", "A/x", "B"]);
    expect(opts[2].label.endsWith("x")).toBe(true);
    expect(opts[2].label.length).toBeGreaterThan(opts[1].label.length);
  });
});
