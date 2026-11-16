import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Save, Trash2, X } from "lucide-react";
import {
  errorMessage,
  notesDelete,
  notesMove,
  notesRead,
  notesRename,
  notesSave,
  notesSetTags,
  type NoteEntry,
} from "../../lib/api";
import { InlineError } from "../../components/InlineError";
import { MarkdownView } from "./MarkdownView";
import { TableEditor } from "./TableEditor";
import { folderOptions, KIND_LABEL } from "./notesModel";

interface Base {
  content: string;
  /** The file's `updatedAt` when this content was loaded/saved. */
  updatedAt: number;
}

export interface NoteEditorProps {
  shared: string | null;
  /** The note's current metadata (kept fresh from the tree query). */
  entry: NoteEntry;
  folders: string[];
  /** Every tag in the store, offered as suggestions. */
  knownTags: string[];
  /** Focus + select the name field on mount (used right after creating). */
  focusName: boolean;
  onDirtyChange: (dirty: boolean) => void;
  /** The note's metadata changed (save/rename/move/tags); `from` is its path before. */
  onChanged: (entry: NoteEntry, from: string) => void;
  onDeleted: (path: string) => void;
}

/**
 * Edit one note: name, folder, tags, and content (text/Markdown textarea with
 * preview, or the table grid). Content is saved explicitly (button or
 * Ctrl/Cmd+S) with the loaded `updatedAt` as a guard, so a change made on
 * another device through the shared folder is never silently overwritten.
 * Name, folder and tags apply immediately.
 */
export function NoteEditor(props: NoteEditorProps) {
  const { shared, entry, onDirtyChange, onChanged } = props;
  const [base, setBase] = useState<Base | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [preview, setPreview] = useState(false);
  const [nameDraft, setNameDraft] = useState(entry.name);
  const [tagDraft, setTagDraft] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const dirty = base !== null && draft !== base.content;

  // Latest values for async callbacks, so a slow read never applies stale state.
  const pathRef = useRef(entry.path);
  useEffect(() => {
    pathRef.current = entry.path;
  }, [entry.path]);

  const load = useCallback(
    async (updatedAt: number) => {
      try {
        const content = await notesRead(shared, pathRef.current);
        setBase({ content, updatedAt });
        setDraft(content);
        setConflict(false);
        setLoadError(null);
      } catch (e) {
        setLoadError(errorMessage(e));
      }
    },
    [shared],
  );

  // Initial load (the page keys this component per opened note).
  useEffect(() => {
    void load(entry.updatedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // Focus the name once the form exists (it renders only after the content
  // loads), and only the first time — never steal focus on a later reload.
  const focusedName = useRef(false);
  const loaded = base !== null;
  useEffect(() => {
    if (props.focusName && loaded && !focusedName.current) {
      focusedName.current = true;
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [props.focusName, loaded]);

  useEffect(() => setNameDraft(entry.name), [entry.name]);

  // The file changed on disk since we loaded it (another device, an external
  // editor). Clean → quietly take the new version; dirty → ask.
  const changedOnDisk = base !== null && entry.updatedAt !== base.updatedAt;
  useEffect(() => {
    if (changedOnDisk && !dirty) void load(entry.updatedAt);
  }, [changedOnDisk, dirty, entry.updatedAt, load]);

  async function save(force: boolean) {
    if (!base || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await notesSave(
        shared,
        entry.path,
        draft,
        force ? null : base.updatedAt,
      );
      if (result.saved) {
        setBase({ content: draft, updatedAt: result.entry.updatedAt });
        setConflict(false);
        onChanged(result.entry, entry.path);
      } else {
        setConflict(true);
        onChanged(result.entry, entry.path);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function run(action: () => Promise<NoteEntry>) {
    setError(null);
    try {
      props.onChanged(await action(), entry.path);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function commitName() {
    const name = nameDraft.trim();
    if (name === "" || name === entry.name) {
      setNameDraft(entry.name);
      return;
    }
    void run(() => notesRename(shared, entry.path, name));
  }

  function setTags(tags: string[]) {
    void run(() => notesSetTags(shared, entry.path, tags));
  }

  function addTag() {
    const incoming = tagDraft
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    setTagDraft("");
    if (incoming.length > 0) setTags([...entry.tags, ...incoming]);
  }

  async function remove() {
    if (!window.confirm(`Delete "${entry.name}"? This can't be undone.`))
      return;
    try {
      await notesDelete(shared, entry.path);
      props.onDeleted(entry.path);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save(false);
    }
  }

  if (loadError) {
    return <InlineError message={`Couldn't open this note: ${loadError}`} />;
  }
  if (!base) {
    return <div className="text-sm text-zinc-500">Loading…</div>;
  }

  const suggestions = props.knownTags.filter((t) => !entry.tags.includes(t));

  return (
    <div onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          ref={nameRef}
          value={nameDraft}
          aria-label="Note name"
          onChange={(e) => setNameDraft(e.currentTarget.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              setNameDraft(entry.name);
              e.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 rounded bg-transparent px-1.5 py-1 text-lg font-semibold text-zinc-100 outline-none hover:bg-zinc-900 focus:bg-zinc-800"
        />
        <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
          {KIND_LABEL[entry.kind]}
        </span>
        <button
          type="button"
          onClick={() => void save(false)}
          disabled={!dirty || saving}
          title="Save (Ctrl/Cmd+S)"
          className="flex shrink-0 items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          <Save size={12} /> {saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          aria-label="Delete note"
          title="Delete note"
          className="shrink-0 rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-rose-400"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
        <label className="flex items-center gap-1.5">
          Folder
          <select
            value={entry.folder}
            onChange={(e) =>
              void run(() =>
                notesMove(shared, entry.path, e.currentTarget.value),
              )
            }
            className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200 outline-none"
          >
            {folderOptions(props.folders).map((o) => (
              <option key={o.path} value={o.path}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="flex flex-wrap items-center gap-1">
          Tags
          {entry.tags.map((t) => (
            <span
              key={t}
              className="flex items-center gap-0.5 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300"
            >
              {t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => setTags(entry.tags.filter((x) => x !== t))}
                className="text-zinc-500 hover:text-rose-400"
              >
                <X size={10} />
              </button>
            </span>
          ))}
          <input
            value={tagDraft}
            list="notes-known-tags"
            aria-label="Add tag"
            placeholder="add tag…"
            onChange={(e) => setTagDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag();
              }
            }}
            onBlur={addTag}
            className="w-24 rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-200 outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <datalist id="notes-known-tags">
            {suggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </span>
      </div>

      {(conflict || (changedOnDisk && dirty)) && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded border border-amber-800/60 bg-amber-950/30 px-2 py-1.5 text-xs text-amber-300/90"
        >
          This note was changed elsewhere (another device or program) after you
          opened it.
          <button
            type="button"
            onClick={() => void load(entry.updatedAt)}
            className="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-900/40"
          >
            Discard my edits &amp; reload
          </button>
          <button
            type="button"
            onClick={() => void save(true)}
            className="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-900/40"
          >
            Overwrite with mine
          </button>
        </div>
      )}
      <InlineError message={error} className="text-xs text-rose-400" />

      {entry.kind === "table" ? (
        <TableEditor value={draft} onChange={setDraft} />
      ) : (
        <>
          {entry.kind === "markdown" && (
            <div
              role="tablist"
              aria-label="Markdown view"
              className="flex w-fit overflow-hidden rounded border border-zinc-700 text-xs"
            >
              {([false, true] as const).map((p) => (
                <button
                  key={String(p)}
                  role="tab"
                  type="button"
                  aria-selected={preview === p}
                  onClick={() => setPreview(p)}
                  className={`px-2 py-1 ${preview === p ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800"}`}
                >
                  {p ? "Preview" : "Edit"}
                </button>
              ))}
            </div>
          )}
          {entry.kind === "markdown" && preview ? (
            <div className="min-h-64 flex-1 overflow-auto rounded border border-zinc-800 p-3">
              <MarkdownView source={draft} />
            </div>
          ) : (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              spellCheck
              aria-label="Note content"
              placeholder="Start writing…"
              className="min-h-64 flex-1 resize-none rounded border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-zinc-100 outline-none focus:border-indigo-500"
            />
          )}
        </>
      )}
    </div>
  );
}
