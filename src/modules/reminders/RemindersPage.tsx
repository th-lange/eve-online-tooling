import { useEffect, useState } from "react";
import { Trash2, Pencil } from "lucide-react";
import { useReminders } from "./reminderContext";
import {
  formatRepeat,
  REMINDER_CATEGORIES,
  sortByDue,
  type ReminderCategory,
} from "./reminders";
import { ModuleBadge } from "./ModuleBadge";
import { WhenField } from "./WhenField";
import { RepeatField } from "./RepeatField";
import { Page, PageHeader } from "../../components/page";

/** Default a new reminder to one hour out. */
function defaultWhen(): number {
  return Date.now() + 60 * 60_000;
}

/**
 * The Reminders module page: register one-shot reminders (what / when /
 * optional note) for PI, production, invention, or anything else. The firing —
 * desktop notification + the in-app "due" modal — lives in
 * {@link ReminderProvider} at the app root; this page is just the editor.
 * Reminders only fire while the app is open; one that came due while it was
 * closed is surfaced on the next launch.
 */
export function RemindersPage() {
  const { reminders, add, update, remove } = useReminders();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [category, setCategory] = useState<ReminderCategory>("pi");
  const [what, setWhat] = useState("");
  const [note, setNote] = useState("");
  const [dueAt, setDueAt] = useState(defaultWhen);
  const [repeatMs, setRepeatMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // When "Edit" is clicked, load that reminder into the form.
  useEffect(() => {
    if (editingId == null) return;
    const r = reminders.find((x) => x.id === editingId);
    if (!r) {
      setEditingId(null);
      return;
    }
    setCategory(r.category);
    setWhat(r.what);
    setNote(r.note);
    setDueAt(r.dueAt);
    setRepeatMs(r.repeatMs ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const resetForm = () => {
    setEditingId(null);
    setCategory("pi");
    setWhat("");
    setNote("");
    setDueAt(defaultWhen());
    setRepeatMs(null);
    setError(null);
  };

  const submit = () => {
    const trimmed = what.trim();
    if (!trimmed) {
      setError("Give the reminder a short description.");
      return;
    }
    if (Number.isNaN(dueAt)) {
      setError("Pick a valid date and time.");
      return;
    }
    const draft = {
      category,
      what: trimmed,
      note: note.trim(),
      dueAt,
      repeatMs,
    };
    if (editingId != null) update(editingId, draft);
    else add(draft);
    resetForm();
  };

  const now = Date.now();
  const sorted = sortByDue(reminders);

  return (
    <Page>
      <PageHeader
        title="Reminders"
        subtitle="Remind yourself about PI extractions, production or invention jobs, or anything else. Reminders fire only while the app is open; one whose time passed while it was closed is shown the next time you launch."
      />
      <div className="mt-6">
        {/* List */}
        {sorted.length > 0 ? (
          <ul className="mt-3 divide-y divide-zinc-800 rounded-md border border-zinc-800">
            {sorted.map((r) => {
              const overdue = r.dueAt <= now;
              return (
                <li
                  key={r.id}
                  className="flex items-start justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-zinc-100">
                        {r.what}
                      </span>
                      <ModuleBadge reminder={r} />
                    </div>
                    <div
                      className={`mt-0.5 text-xs ${
                        overdue ? "text-amber-400" : "text-zinc-500"
                      }`}
                    >
                      {new Date(r.dueAt).toLocaleString()}
                      {overdue ? " · overdue" : ""}
                      {r.repeatMs ? ` · ${formatRepeat(r.repeatMs)}` : ""}
                    </div>
                    {r.note && (
                      <p className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-400">
                        {r.note}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setEditingId(r.id)}
                      title="Edit reminder"
                      aria-label={`Edit reminder: ${r.what}`}
                      className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (editingId === r.id) resetForm();
                        remove(r.id);
                      }}
                      title="Delete reminder"
                      aria-label={`Delete reminder: ${r.what}`}
                      className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-rose-400"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 rounded-md border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">
            No reminders yet.
          </p>
        )}

        {/* Add / edit form */}
        <div className="mt-4 grid gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Type</span>
              <select
                value={category}
                onChange={(e) =>
                  setCategory(e.currentTarget.value as ReminderCategory)
                }
                aria-label="Reminder type"
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
              >
                {REMINDER_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
              <span className="text-xs text-zinc-500">What</span>
              <input
                type="text"
                value={what}
                onChange={(e) => setWhat(e.currentTarget.value)}
                placeholder="e.g. Pator colony extraction"
                aria-label="What to be reminded about"
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">When</span>
            <WhenField value={dueAt} onChange={setDueAt} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Repeat</span>
            <RepeatField value={repeatMs} onChange={setRepeatMs} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              rows={2}
              placeholder="Anything else you want to remember."
              aria-label="Reminder note"
              className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
            />
          </label>
          {error && <p className="text-xs text-rose-400">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
            >
              {editingId != null ? "Save reminder" : "Add reminder"}
            </button>
            {editingId != null && (
              <button
                type="button"
                onClick={resetForm}
                className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}
