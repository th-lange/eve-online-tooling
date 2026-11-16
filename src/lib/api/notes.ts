import { invoke } from "@tauri-apps/api/core";

// --- Notes ---
//
// Every call takes `shared`: the configured sync folder (or `null` for none).
// Notes live in `<shared>/notes/` when one is set, else in the app's local
// data dir — the backend resolves that; callers just pass the setting through.

/** Plain text, Markdown, or a CSV table. */
export type NoteKind = "text" | "markdown" | "table";

/** One note's metadata (not its content). */
export interface NoteEntry {
  /** `/`-separated path relative to the notes root, with extension. */
  path: string;
  /** File name without its extension. */
  name: string;
  kind: NoteKind;
  /** Containing folder's path (`""` = root). */
  folder: string;
  tags: string[];
  /** Unix ms file modification time. */
  updatedAt: number;
  /** Bytes. */
  size: number;
}

export interface NoteTree {
  /** Relative folder paths (the root is implicit). */
  folders: string[];
  notes: NoteEntry[];
}

/** `saved: false` ⇒ the file changed elsewhere; `entry` is its current state. */
export interface NoteSaveResult {
  saved: boolean;
  entry: NoteEntry;
}

export interface NoteSearchHit {
  entry: NoteEntry;
  /** One-line excerpt around the first content match ("" if name/tags only). */
  snippet: string;
}

export interface NotesLocation {
  /** Absolute path of the active notes folder. */
  root: string;
  /** True when notes live in the shared folder. */
  shared: boolean;
  /** Local notes missing from the shared store (0 unless `shared`). */
  localOnly: number;
}

export function notesLocation(shared: string | null): Promise<NotesLocation> {
  return invoke<NotesLocation>("notes_location", { shared });
}

/** Copy local notes into the shared store; resolves to how many were copied. */
export function notesImportLocal(shared: string): Promise<number> {
  return invoke<number>("notes_import_local", { shared });
}

export function notesTree(shared: string | null): Promise<NoteTree> {
  return invoke<NoteTree>("notes_tree", { shared });
}

export function notesRead(
  shared: string | null,
  path: string,
): Promise<string> {
  return invoke<string>("notes_read", { shared, path });
}

export function notesCreate(
  shared: string | null,
  folder: string,
  name: string,
  kind: NoteKind,
  content: string,
): Promise<NoteEntry> {
  return invoke<NoteEntry>("notes_create", {
    shared,
    folder,
    name,
    kind,
    content,
  });
}

/** Save content. Pass the `updatedAt` you loaded to detect concurrent edits;
 *  `null` overwrites unconditionally. */
export function notesSave(
  shared: string | null,
  path: string,
  content: string,
  expectedUpdatedAt: number | null,
): Promise<NoteSaveResult> {
  return invoke<NoteSaveResult>("notes_save", {
    shared,
    path,
    content,
    expectedUpdatedAt,
  });
}

export function notesRename(
  shared: string | null,
  path: string,
  name: string,
): Promise<NoteEntry> {
  return invoke<NoteEntry>("notes_rename", { shared, path, name });
}

export function notesMove(
  shared: string | null,
  path: string,
  folder: string,
): Promise<NoteEntry> {
  return invoke<NoteEntry>("notes_move", { shared, path, folder });
}

export function notesDelete(
  shared: string | null,
  path: string,
): Promise<void> {
  return invoke<void>("notes_delete", { shared, path });
}

export function notesSetTags(
  shared: string | null,
  path: string,
  tags: string[],
): Promise<NoteEntry> {
  return invoke<NoteEntry>("notes_set_tags", { shared, path, tags });
}

/** Resolves to the new folder's path. */
export function notesCreateFolder(
  shared: string | null,
  parent: string,
  name: string,
): Promise<string> {
  return invoke<string>("notes_create_folder", { shared, parent, name });
}

/** Resolves to the folder's new path. */
export function notesRenameFolder(
  shared: string | null,
  path: string,
  name: string,
): Promise<string> {
  return invoke<string>("notes_rename_folder", { shared, path, name });
}

/** Resolves to the folder's new path. */
export function notesMoveFolder(
  shared: string | null,
  path: string,
  parent: string,
): Promise<string> {
  return invoke<string>("notes_move_folder", { shared, path, parent });
}

/** Deletes the folder and everything in it. */
export function notesDeleteFolder(
  shared: string | null,
  path: string,
): Promise<void> {
  return invoke<void>("notes_delete_folder", { shared, path });
}

export function notesSearch(
  shared: string | null,
  query: string,
): Promise<NoteSearchHit[]> {
  return invoke<NoteSearchHit[]>("notes_search", { shared, query });
}
