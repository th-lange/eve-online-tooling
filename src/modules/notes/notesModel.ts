// Pure helpers for the Notes page: folder tree shaping, tag counts, sorting.

import type { NoteEntry, NoteKind } from "../../lib/api";
import type { SortDir } from "../../lib/usePersistentSort";

/** Drag payload types: a note's path / a folder's path. */
export const DRAG_NOTE = "application/x-eve-note";
export const DRAG_FOLDER = "application/x-eve-folder";

export const KIND_LABEL: Record<NoteKind, string> = {
  markdown: "Markdown",
  text: "Text",
  table: "Table",
};

export const NOTE_SORT_KEYS = [
  "name",
  "folder",
  "kind",
  "tags",
  "updatedAt",
  "size",
] as const;
export type NoteSortKey = (typeof NOTE_SORT_KEYS)[number];

/** Columns whose first click should sort ascending (text), not descending. */
export const NOTE_TEXT_SORT_KEYS: readonly NoteSortKey[] = [
  "name",
  "folder",
  "kind",
  "tags",
];

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

/** Sort a copy of `notes`. Ties fall back to name so order is stable. */
export function sortNotes(
  notes: NoteEntry[],
  key: NoteSortKey,
  dir: SortDir,
): NoteEntry[] {
  const sign = dir === "asc" ? 1 : -1;
  const value = (n: NoteEntry): string | number => {
    switch (key) {
      case "name":
        return n.name;
      case "folder":
        return n.folder;
      case "kind":
        return KIND_LABEL[n.kind];
      case "tags":
        return n.tags.join(" ");
      case "updatedAt":
        return n.updatedAt;
      case "size":
        return n.size;
    }
  };
  return [...notes].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const primary =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : compareText(String(va), String(vb));
    return sign * primary || compareText(a.name, b.name);
  });
}

/** Parent folder of a folder path (`""` for top-level and for the root). */
export function parentOf(folder: string): string {
  const i = folder.lastIndexOf("/");
  return i < 0 ? "" : folder.slice(0, i);
}

/** Last path component. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** True if `path` is `folder` or lives anywhere beneath it. */
export function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

export interface FolderNode {
  /** Full relative path (`""` for the root node). */
  path: string;
  name: string;
  children: FolderNode[];
  /** Notes directly in this folder. */
  noteCount: number;
}

/** Nest the flat folder list under a synthetic root node. Also tolerates a
 *  folder whose parent is missing from the list by creating it. */
export function buildFolderTree(
  folders: string[],
  notes: NoteEntry[],
): FolderNode {
  const nodes = new Map<string, FolderNode>();
  const root: FolderNode = { path: "", name: "", children: [], noteCount: 0 };
  nodes.set("", root);

  const ensure = (path: string): FolderNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: FolderNode = {
      path,
      name: baseName(path),
      children: [],
      noteCount: 0,
    };
    nodes.set(path, node);
    ensure(parentOf(path)).children.push(node);
    return node;
  };

  for (const f of folders) ensure(f);
  for (const n of notes) ensure(n.folder).noteCount++;
  for (const node of nodes.values()) {
    node.children.sort((a, b) => compareText(a.name, b.name));
  }
  return root;
}

/** Notes directly in `folder`, or every note when `folder` is `null`. */
export function notesInFolder(
  notes: NoteEntry[],
  folder: string | null,
): NoteEntry[] {
  return folder === null ? notes : notes.filter((n) => n.folder === folder);
}

/** Notes carrying `tag` (all notes when `tag` is `null`). */
export function notesWithTag(
  notes: NoteEntry[],
  tag: string | null,
): NoteEntry[] {
  return tag === null ? notes : notes.filter((n) => n.tags.includes(tag));
}

export interface TagCount {
  tag: string;
  count: number;
}

/** Every tag in use, most-used first, then alphabetical. */
export function collectTags(notes: NoteEntry[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const n of notes) {
    for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || compareText(a.tag, b.tag));
}

/** Every folder path as a flat, indented-by-depth list (root first) — the
 *  option list for "Move to…" selects. */
export function folderOptions(
  folders: string[],
): { path: string; label: string }[] {
  const out = [{ path: "", label: "Notes (top level)" }];
  const sorted = [...folders].sort((a, b) => compareText(a, b));
  for (const f of sorted) {
    const depth = f.split("/").length - 1;
    out.push({
      path: f,
      label: `${"\u00a0\u00a0".repeat(depth)}${baseName(f)}`,
    });
  }
  return out;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a new note of `kind` starts with. Tables get a header row and one
 *  blank row so the grid isn't empty. */
export function starterContent(kind: NoteKind): string {
  return kind === "table" ? "Column 1,Column 2,Column 3\n,,\n" : "";
}
