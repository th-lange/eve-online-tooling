import { useState } from "react";
import type { DpsLogFile } from "../../lib/api";
import { formatLogDate, type Mode } from "./dpsMeterShared";

/** Searchable gamelog picker: type to filter by filename; each row (and the
 *  collapsed field once picked) shows the file's modified date, so you can
 *  tell sessions apart at a glance instead of reading raw filenames (#719). */
function LogFilePicker({
  logs,
  file,
  onPick,
}: {
  logs: DpsLogFile[];
  file: string;
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = logs.find((l) => l.path === file) ?? null;
  const label = selected
    ? `${selected.name} — ${formatLogDate(selected.modified)}`
    : "";
  const q = query.trim().toLowerCase();
  const matches = q
    ? logs.filter((l) => l.name.toLowerCase().includes(q))
    : logs;

  return (
    <div className="relative flex-1 min-w-[16rem]">
      <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
        Log file
      </span>
      <input
        value={open ? query : label}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        placeholder={
          logs.length === 0 ? "No logs found" : "search by filename…"
        }
        className="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
      />
      {open && (
        // Keep focus on the input on mousedown (no default) so blur never
        // fires before the row's onClick runs — the dropdown closes there.
        <div
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded border border-zinc-700 bg-zinc-900 text-sm shadow-lg"
        >
          {matches.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-zinc-500">No matches.</div>
          )}
          {matches.map((l) => (
            <button
              key={l.path}
              onClick={() => {
                onPick(l.path);
                setQuery("");
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-zinc-800 ${
                l.path === file
                  ? "bg-zinc-800/70 text-zinc-100"
                  : "text-zinc-300"
              }`}
            >
              <span className="truncate">{l.name}</span>
              <span className="ml-2 shrink-0 text-[11px] tabular-nums text-zinc-500">
                {formatLogDate(l.modified)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Source selection: gamelogs folder, moving-average window, and — in
 *  playback mode — which log file to replay and at what speed. */
export function LogFilePanel({
  dir,
  onSetDir,
  mode,
  onDirBlur,
  windowSecs,
  onSetWindow,
  logs,
  file,
  onSetFile,
  speed,
  onSetSpeed,
  characters,
  character,
  onSetCharacter,
}: {
  dir: string;
  onSetDir: (v: string) => void;
  mode: Mode;
  onDirBlur: () => void;
  windowSecs: number;
  onSetWindow: (s: number) => void;
  logs: DpsLogFile[];
  file: string;
  onSetFile: (path: string) => void;
  speed: number;
  onSetSpeed: (n: number) => void;
  /** Distinct characters seen in the folder's logs in the last 24h (#870). */
  characters: string[];
  /** Selected character to follow; `""` = newest file (unchanged behavior). */
  character: string;
  onSetCharacter: (name: string) => void;
}) {
  return (
    <>
      <label className="flex-1 min-w-[20rem]">
        <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
          Gamelogs folder
        </span>
        <input
          value={dir}
          onChange={(e) => onSetDir(e.currentTarget.value)}
          onBlur={onDirBlur}
          placeholder="…/EVE/logs/Gamelogs"
          className="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
      </label>
      {characters.length > 0 && (
        <label className="min-w-[10rem]">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
            Character
          </span>
          <select
            value={character}
            onChange={(e) => onSetCharacter(e.currentTarget.value)}
            className="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none"
          >
            <option value="">Newest log (any character)</option>
            {characters.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
      <div>
        <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
          Window (s)
        </span>
        <div className="flex overflow-hidden rounded border border-zinc-800 text-sm">
          {([10, 20, 30, 60] as const).map((s) => (
            <button
              key={s}
              onClick={() => onSetWindow(s)}
              aria-pressed={windowSecs === s}
              className={`px-2.5 py-1.5 tabular-nums ${
                windowSecs === s
                  ? "bg-zinc-700 text-zinc-100"
                  : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {mode === "playback" && (
        <>
          <LogFilePicker logs={logs} file={file} onPick={onSetFile} />
          <label className="min-w-[9rem]">
            <span className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
              <span>Speed ×</span>
              <span className="tabular-nums text-zinc-300">
                {speed.toFixed(1)}×
              </span>
            </span>
            <input
              type="range"
              aria-label="Playback speed"
              min={0.1}
              max={10}
              step={0.1}
              value={speed}
              onChange={(e) => onSetSpeed(Number(e.currentTarget.value))}
              className="mt-2 w-32 accent-emerald-500"
            />
          </label>
        </>
      )}
    </>
  );
}
