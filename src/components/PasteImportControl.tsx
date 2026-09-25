import { useState } from "react";
import { ClipboardPaste } from "lucide-react";

/**
 * Collapsible paste-to-import control (#710): a button that opens a small
 * textarea popover. Used for pasted fits/item lists (Fitting) and pasted
 * blueprint-name lists (Mass Production, #883) — the parse happens in the
 * caller's `onImport`. Closes on Import; errors surface via the caller's
 * `InlineError`.
 */
export function PasteImportControl({
  label,
  title,
  placeholder,
  value,
  setValue,
  onImport,
  pending,
  mono = false,
}: {
  label: string;
  title: string;
  placeholder: string;
  value: string;
  setValue: (v: string) => void;
  onImport: () => void;
  pending: boolean;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={title}
        className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
          open
            ? "border-zinc-600 bg-zinc-800 text-zinc-200"
            : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
        }`}
      >
        <ClipboardPaste size={13} />
        {label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 w-96 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
            <textarea
              value={value}
              onChange={(e) => setValue(e.currentTarget.value)}
              placeholder={placeholder}
              autoFocus
              className={`h-32 w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 ${
                mono ? "font-mono" : ""
              }`}
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onImport();
                  setOpen(false);
                }}
                disabled={value.trim().length === 0 || pending}
                className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {pending ? "Importing…" : "Import"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
