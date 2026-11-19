import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlignLeft, FileText, Search, Table, X } from "lucide-react";
import {
  errorMessage,
  notesCreate,
  notesCreateFolder,
  notesDeleteFolder,
  notesImportLocal,
  notesLocation,
  notesMove,
  notesMoveFolder,
  notesRenameFolder,
  notesSearch,
  notesTree,
  type NoteEntry,
  type NoteKind,
  type NoteTree,
} from "../../lib/api";
import { notesKeys } from "../../lib/queryKeys";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { formatAgo } from "../../lib/format";
import { DataTable, type SortColumn } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { InlineError } from "../../components/InlineError";
import { Page, PageHeader } from "../../components/page";
import { FolderTree } from "./FolderTree";
import { NoteEditor } from "./NoteEditor";
import {
  buildFolderTree,
  collectTags,
  DRAG_NOTE,
  formatSize,
  isWithin,
  KIND_LABEL,
  NOTE_SORT_KEYS,
  NOTE_TEXT_SORT_KEYS,
  notesInFolder,
  notesWithTag,
  parentOf,
  sortNotes,
  starterContent,
  type NoteSortKey,
} from "./notesModel";
import { useSharedFolder } from "./useSharedFolder";

const SUBTITLE =
  "Text, Markdown and CSV table notes in named folders — tag them, sort them, search everything. Notes are saved in your shared sync folder when one is set up.";

const COLUMNS: SortColumn<NoteSortKey>[] = [
  {
    key: "name",
    label: "Name",
    numeric: false,
    description: "The note's name.",
  },
  {
    key: "folder",
    label: "Folder",
    numeric: false,
    description: "The folder the note is filed in.",
  },
  {
    key: "kind",
    label: "Type",
    numeric: false,
    description: "Markdown, plain text, or a CSV table.",
  },
  {
    key: "tags",
    label: "Tags",
    numeric: false,
    description: "Labels attached to the note.",
  },
  {
    key: "updatedAt",
    label: "Modified",
    numeric: true,
    description: "When the note was last changed.",
  },
  {
    key: "size",
    label: "Size",
    numeric: true,
    description: "The note's file size.",
  },
];

const NEW_KINDS: { kind: NoteKind; label: string }[] = [
  { kind: "markdown", label: "Markdown" },
  { kind: "text", label: "Text" },
  { kind: "table", label: "Table" },
];

function KindIcon({ kind }: { kind: NoteKind }) {
  const props = { size: 14, className: "shrink-0 text-zinc-500" };
  if (kind === "table") return <Table {...props} aria-label="Table" />;
  if (kind === "text") return <AlignLeft {...props} aria-label="Text" />;
  return <FileText {...props} aria-label="Markdown" />;
}

function TagChip({
  tag,
  active,
  onClick,
}: {
  tag: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-pressed={active}
      className={`rounded px-1.5 py-0.5 text-xs ${
        active
          ? "bg-indigo-600 text-white"
          : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
      }`}
    >
      {tag}
    </button>
  );
}

/** `from` → `to` for a path that is `from` or lives under it. */
function remap(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap each search term inside `text` in <mark>. */
function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (terms.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.join("|")})`, "i"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-amber-500/30 text-amber-100">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export function NotesPage() {
  const shared = useSharedFolder();
  // Re-keyed per store so switching between local and shared starts clean
  // (no stale selection/open note pointing into the other store).
  return <NotesWorkspace key={shared ?? "local"} shared={shared} />;
}

interface OpenNote {
  /** Bumped per opened note so the editor remounts; stable across renames. */
  key: number;
  path: string;
  focusName: boolean;
}

function NotesWorkspace({ shared }: { shared: string | null }) {
  const qc = useQueryClient();
  const { sortKey, sortDir, toggleSort } = usePersistentSort<NoteSortKey>(
    "sort.notes",
    NOTE_SORT_KEYS,
    "updatedAt",
    "desc",
    NOTE_TEXT_SORT_KEYS,
  );

  // `null` = all notes, `""` = top level, otherwise a folder path.
  const [folder, setFolder] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState<OpenNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openKey = useRef(0);
  const dirtyRef = useRef(false);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const tree = useQuery({
    queryKey: notesKeys.tree(shared),
    queryFn: () => notesTree(shared),
    // A shared drive can change underneath us; pick that up while visible.
    refetchInterval: 30_000,
  });
  const location = useQuery({
    queryKey: notesKeys.location(shared),
    queryFn: () => notesLocation(shared),
  });
  const searching = debouncedQuery !== "";
  const search = useQuery({
    queryKey: notesKeys.search(shared, debouncedQuery),
    queryFn: () => notesSearch(shared, debouncedQuery),
    enabled: searching,
  });

  const notes = tree.data?.notes ?? [];
  const folders = tree.data?.folders ?? [];
  const openEntry = open ? notes.find((n) => n.path === open.path) : undefined;

  // The open note vanished (deleted on another device): close it. Skipped
  // while a refetch is in flight so a just-created/renamed note is never
  // mistaken for a missing one.
  useEffect(() => {
    if (open && tree.data && !tree.isFetching && !openEntry) {
      dirtyRef.current = false;
      setOpen(null);
    }
  }, [open, openEntry, tree.data, tree.isFetching]);

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  /** Ask before abandoning unsaved edits; true = go ahead. */
  function confirmDiscard(): boolean {
    return (
      !dirtyRef.current ||
      window.confirm("You have unsaved changes in this note. Discard them?")
    );
  }

  function refresh() {
    return qc.invalidateQueries({ queryKey: notesKeys.all });
  }

  /** Run a mutation, surfacing failures inline and refreshing afterwards. */
  async function mutate(op: () => Promise<void>) {
    setError(null);
    setNotice(null);
    try {
      await op();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      void refresh();
    }
  }

  function openNote(path: string, focusName = false) {
    if (open?.path === path) return;
    if (!confirmDiscard()) return;
    dirtyRef.current = false;
    setOpen({ key: ++openKey.current, path, focusName });
  }

  function patchEntry(entry: NoteEntry, from: string) {
    qc.setQueryData<NoteTree>(
      notesKeys.tree(shared),
      (t) =>
        t && { ...t, notes: t.notes.map((n) => (n.path === from ? entry : n)) },
    );
    setOpen((o) => (o && o.path === from ? { ...o, path: entry.path } : o));
    void refresh();
  }

  async function createNote(kind: NoteKind) {
    if (!confirmDiscard()) return;
    await mutate(async () => {
      const entry = await notesCreate(
        shared,
        folder ?? "",
        "Untitled",
        kind,
        starterContent(kind),
      );
      // Upsert, not append: a tree refetch already in flight can land with the
      // new file in it, and a second row sharing its path would collide (same
      // React key) until the next refetch dropped it.
      qc.setQueryData<NoteTree>(
        notesKeys.tree(shared),
        (t) =>
          t && {
            ...t,
            notes: t.notes.some((n) => n.path === entry.path)
              ? t.notes.map((n) => (n.path === entry.path ? entry : n))
              : [...t.notes, entry],
          },
      );
      // Show it even if the current filter would hide it.
      if (tag !== null) setTag(null);
      setQuery("");
      dirtyRef.current = false;
      setOpen({ key: ++openKey.current, path: entry.path, focusName: true });
    });
  }

  const moveNote = (path: string, to: string) =>
    mutate(async () => {
      const entry = await notesMove(shared, path, to);
      if (entry.path !== path) patchEntry(entry, path);
    });

  const createFolder = (parent: string, name: string) =>
    mutate(async () => {
      setFolder(await notesCreateFolder(shared, parent, name));
    });

  const renameFolder = (path: string, name: string) =>
    mutate(async () => {
      const next = await notesRenameFolder(shared, path, name);
      applyFolderRename(path, next);
    });

  const moveFolder = (path: string, parent: string) =>
    mutate(async () => {
      const next = await notesMoveFolder(shared, path, parent);
      applyFolderRename(path, next);
    });

  /** A folder's path changed: carry the cache, selection and open note along
   *  immediately, so nothing (least of all an editor with unsaved edits)
   *  unmounts while the refetch is in flight. */
  function applyFolderRename(from: string, to: string) {
    qc.setQueryData<NoteTree>(
      notesKeys.tree(shared),
      (t) =>
        t && {
          folders: t.folders.map((f) => remap(f, from, to)),
          notes: t.notes.map((n) =>
            isWithin(n.path, from)
              ? {
                  ...n,
                  path: remap(n.path, from, to),
                  folder: remap(n.folder, from, to),
                }
              : n,
          ),
        },
    );
    setFolder((f) => (f === null ? f : remap(f, from, to)));
    setOpen((o) => (o ? { ...o, path: remap(o.path, from, to) } : o));
  }

  async function deleteFolder(path: string) {
    const count = notes.filter((n) => isWithin(n.folder, path)).length;
    const message =
      count === 0
        ? `Delete the empty folder "${path}"?`
        : `Delete the folder "${path}" and the ${count} note${count === 1 ? "" : "s"} in it? This can't be undone.`;
    if (!window.confirm(message)) return;
    await mutate(async () => {
      await notesDeleteFolder(shared, path);
      setFolder((f) => (f !== null && isWithin(f, path) ? parentOf(path) : f));
      if (open && isWithin(open.path, path)) {
        dirtyRef.current = false;
        setOpen(null);
      }
    });
  }

  async function copyLocalToShared() {
    if (!shared) return;
    await mutate(async () => {
      const n = await notesImportLocal(shared);
      setNotice(`Copied ${n} note${n === 1 ? "" : "s"} to the shared folder.`);
    });
  }

  const root = buildFolderTree(folders, notes);
  const tags = collectTags(notes);
  const knownTags = tags.map((t) => t.tag);
  const inFolder = notesWithTag(notesInFolder(notes, folder), tag);
  // Inside one folder the Folder column is redundant; fall back to Name if the
  // persisted sort was on it.
  const showFolder = folder === null;
  const activeSortKey = !showFolder && sortKey === "folder" ? "name" : sortKey;
  const columns = showFolder
    ? COLUMNS
    : COLUMNS.filter((c) => c.key !== "folder");
  const rows = sortNotes(inFolder, activeSortKey, sortDir);
  const hits = (search.data ?? []).filter(
    (h) => tag === null || h.entry.tags.includes(tag),
  );

  return (
    <Page>
      <PageHeader
        title="Notes"
        subtitle={SUBTITLE}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="relative">
              <Search
                size={13}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Search all notes…"
                aria-label="Search notes"
                className="w-56 rounded border border-zinc-700 bg-zinc-950 py-1.5 pl-7 pr-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
              />
            </label>
            {NEW_KINDS.map(({ kind, label }) => (
              <button
                key={kind}
                type="button"
                onClick={() => void createNote(kind)}
                className="rounded bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
              >
                + {label}
              </button>
            ))}
          </div>
        }
      />

      {location.data && (
        <div className="mt-3 text-xs">
          {location.data.shared ? (
            <p className="text-zinc-500">
              Saved in your shared folder:{" "}
              <span className="font-mono text-zinc-400">
                {location.data.root}
              </span>
            </p>
          ) : (
            <p className="text-zinc-500">
              Saved on this device only
              <span className="font-mono text-zinc-500">
                {" "}
                ({location.data.root})
              </span>
              . To keep notes on a shared drive, choose and activate a sync
              folder in Settings → Sync.
            </p>
          )}
          {location.data.shared && location.data.localOnly > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-800/60 bg-amber-950/30 px-2 py-1.5 text-amber-300/90">
              {location.data.localOnly} note
              {location.data.localOnly === 1 ? "" : "s"} on this device
              {location.data.localOnly === 1 ? " isn't" : " aren't"} in the
              shared folder yet.
              <button
                type="button"
                onClick={() => void copyLocalToShared()}
                className="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-900/40"
              >
                Copy to shared folder
              </button>
            </div>
          )}
        </div>
      )}
      <InlineError message={error} className="mt-2 text-sm text-rose-400" />
      {notice && <p className="mt-2 text-sm text-emerald-400">{notice}</p>}
      {tree.error && (
        <InlineError
          message={`Couldn't load notes: ${errorMessage(tree.error)}`}
        />
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[14rem_minmax(0,1.25fr)_minmax(0,1fr)]">
        <aside className="space-y-4">
          <FolderTree
            root={root}
            totalNotes={notes.length}
            selected={folder}
            onSelect={(f) => {
              setFolder(f);
              setQuery("");
            }}
            onCreateFolder={(p, n) => void createFolder(p, n)}
            onRenameFolder={(p, n) => void renameFolder(p, n)}
            onDeleteFolder={(p) => void deleteFolder(p)}
            onMoveNote={(p, to) => void moveNote(p, to)}
            onMoveFolder={(p, to) => void moveFolder(p, to)}
          />
          {tags.length > 0 && (
            <div>
              <h2 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Tags
              </h2>
              <div className="flex flex-wrap gap-1">
                {tags.map((t) => (
                  <TagChip
                    key={t.tag}
                    tag={`${t.tag} ${t.count}`}
                    active={tag === t.tag}
                    onClick={() => setTag(tag === t.tag ? null : t.tag)}
                  />
                ))}
              </div>
            </div>
          )}
        </aside>

        <section aria-label="Notes list" className="min-w-0">
          {tag !== null && (
            <button
              type="button"
              onClick={() => setTag(null)}
              className="mb-2 flex items-center gap-1 rounded bg-indigo-900/50 px-2 py-0.5 text-xs text-indigo-200"
            >
              Tag: {tag} <X size={11} />
            </button>
          )}
          {searching ? (
            <div className="max-h-[calc(100vh-14rem)] space-y-1 overflow-auto">
              {search.isFetching && hits.length === 0 ? (
                <p className="text-sm text-zinc-500">Searching…</p>
              ) : hits.length === 0 ? (
                <EmptyState
                  title={`No notes match "${debouncedQuery}"`}
                  hint="Search looks at note names, folders, tags and everything written inside them."
                />
              ) : (
                hits.map(({ entry, snippet }) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => openNote(entry.path)}
                    className={`block w-full rounded border px-2.5 py-2 text-left hover:bg-zinc-900 ${
                      open?.path === entry.path
                        ? "border-indigo-600 bg-zinc-900"
                        : "border-zinc-800"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-sm text-zinc-100">
                      <KindIcon kind={entry.kind} />
                      <Highlight text={entry.name} query={debouncedQuery} />
                      {entry.folder && (
                        <span className="text-xs text-zinc-500">
                          in {entry.folder}
                        </span>
                      )}
                    </div>
                    {snippet && (
                      <div className="mt-1 text-xs text-zinc-400">
                        <Highlight text={snippet} query={debouncedQuery} />
                      </div>
                    )}
                    {entry.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1 text-xs text-zinc-500">
                        {entry.tags.map((t) => (
                          <span key={t}>#{t}</span>
                        ))}
                      </div>
                    )}
                  </button>
                ))
              )}
            </div>
          ) : (
            <DataTable
              columns={columns}
              sortKey={activeSortKey}
              sortDir={sortDir}
              onSort={toggleSort}
              rows={rows}
              className="max-h-[calc(100vh-14rem)] overflow-auto rounded border border-zinc-800"
              emptyState={
                <EmptyState
                  title={
                    tree.isLoading
                      ? "Loading notes…"
                      : notes.length === 0
                        ? "No notes yet"
                        : "Nothing here"
                  }
                  hint={
                    notes.length === 0
                      ? "Create a Markdown, Text or Table note with the buttons above."
                      : "No notes in this folder (or with this tag). Drag notes from the list onto a folder to file them."
                  }
                />
              }
              renderRow={(n) => (
                <tr
                  key={n.path}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_NOTE, n.path);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => openNote(n.path)}
                  aria-selected={open?.path === n.path}
                  className={`cursor-pointer border-t border-zinc-800/70 hover:bg-zinc-900 ${
                    open?.path === n.path ? "bg-zinc-900" : ""
                  }`}
                >
                  <td className="px-3 py-1.5 text-zinc-100">
                    <span className="flex items-center gap-1.5">
                      <KindIcon kind={n.kind} />
                      {n.name}
                    </span>
                  </td>
                  {showFolder && (
                    <td className="px-3 py-1.5 text-zinc-400">
                      {n.folder || <span className="text-zinc-600">—</span>}
                    </td>
                  )}
                  <td className="px-3 py-1.5 text-zinc-400">
                    {KIND_LABEL[n.kind]}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="flex flex-wrap gap-1">
                      {n.tags.map((t) => (
                        <TagChip
                          key={t}
                          tag={t}
                          active={tag === t}
                          onClick={() => setTag(tag === t ? null : t)}
                        />
                      ))}
                    </span>
                  </td>
                  <td
                    className="px-3 py-1.5 text-right text-zinc-400"
                    title={new Date(n.updatedAt).toLocaleString()}
                  >
                    {formatAgo(n.updatedAt)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-zinc-500">
                    {formatSize(n.size)}
                  </td>
                </tr>
              )}
            />
          )}
        </section>

        <section
          aria-label="Note editor"
          className="flex min-h-96 min-w-0 flex-col"
        >
          {open && openEntry ? (
            <NoteEditor
              key={open.key}
              shared={shared}
              entry={openEntry}
              folders={folders}
              knownTags={knownTags}
              focusName={open.focusName}
              onDirtyChange={onDirtyChange}
              onChanged={patchEntry}
              onDeleted={() => {
                dirtyRef.current = false;
                setOpen(null);
                void refresh();
              }}
            />
          ) : (
            <EmptyState
              title="No note open"
              hint="Pick a note from the list, or create one with + Markdown, + Text or + Table."
            />
          )}
        </section>
      </div>
    </Page>
  );
}
