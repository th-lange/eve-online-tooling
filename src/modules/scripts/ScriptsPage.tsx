import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Play,
  Square,
  Save,
  Trash2,
  Plus,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  scriptsList,
  scriptsSave,
  scriptsDelete,
  scriptsRun,
  scriptsExamples,
  type Script,
  type ScriptLanguage,
  type ScriptRun,
} from "../../lib/api";
import { Page, PageHeader, Centered } from "../../components/page";
import { useScriptRuns, type ScriptRunState } from "./runnerContext";
import { CodeEditor } from "./CodeEditor";

const SUBTITLE =
  "Write small Rhai or JavaScript snippets and run them once, or arm a timed loop. Scripts can log(), notify(title, body), read market_price(typeId) / sde_type_info(typeId) / assets(), and keep state with kv_get(key) / kv_set(key, value).";

const LANGUAGE_LABEL: Record<ScriptLanguage, string> = {
  rhai: "Rhai",
  js: "JavaScript",
};

const STARTER: Record<ScriptLanguage, string> = {
  rhai: `// Rhai — the last expression is the return value.\n// Basic libraries: now(), json_encode/json_decode, plus Rhai's math/string/array.\nlet answer = 6 * 7;\nlog("Hello from Rhai! epoch=" + now());\nanswer`,
  js: `// JavaScript — the completion value is returned.\n// Basic libraries: now(), json_encode/json_decode, plus JS Math/JSON/Date/Array.\nconst answer = 6 * 7;\nlog("Hello from JS! epoch=" + now());\nanswer;`,
};

function blankDraft(): Script {
  return {
    id: "",
    name: "New script",
    language: "rhai",
    code: STARTER.rhai,
    intervalMin: null,
    enabled: false,
    updatedAt: 0,
  };
}

export function ScriptsPage() {
  const qc = useQueryClient();
  const scriptsQ = useQuery({ queryKey: ["scripts"], queryFn: scriptsList });
  const runs = useScriptRuns();
  const examplesQ = useQuery({
    queryKey: ["scripts", "examples"],
    queryFn: scriptsExamples,
  });
  const [draft, setDraft] = useState<Script | null>(null);
  const [output, setOutput] = useState<ScriptRun | null>(null);
  const [examplesOpen, setExamplesOpen] = useState(false);

  const save = useMutation({
    mutationFn: (s: Script) => scriptsSave(s),
    onSuccess: (list, saved) => {
      qc.setQueryData(["scripts"], list);
      const picked = saved.id
        ? list.find((s) => s.id === saved.id)
        : [...list]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .find((s) => s.name === saved.name);
      if (picked) setDraft(picked);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => scriptsDelete(id),
    onSuccess: (list) => {
      qc.setQueryData(["scripts"], list);
      setDraft(null);
      setOutput(null);
    },
  });
  const run = useMutation({
    mutationFn: (s: Script) =>
      scriptsRun({ code: s.code, language: s.language }),
    onSuccess: setOutput,
  });
  // Start/stop a script's loop straight from the list (persists `enabled`; the
  // Rust scheduler picks it up on its next minute). Doesn't disturb the editor
  // selection, but keeps an open draft in sync.
  const toggle = useMutation({
    mutationFn: (next: Script) => scriptsSave(next),
    onSuccess: (list, next) => {
      qc.setQueryData(["scripts"], list);
      setDraft((prev) => (prev && prev.id === next.id ? next : prev));
    },
  });

  if (scriptsQ.isLoading) {
    return (
      <Page>
        <PageHeader title="Scripts" subtitle={SUBTITLE} />
        <Centered>Loading…</Centered>
      </Page>
    );
  }

  const scripts = scriptsQ.data ?? [];
  // The loop always runs the *saved* code (docs/scripts.md), so arming it
  // from a draft that hasn't been saved yet — a brand-new script, or edits
  // to name/language/code/interval since the last save — would be
  // misleading: the checkbox would show "armed" while the scheduler either
  // has nothing to run yet or keeps running the stale saved version.
  const persisted = draft ? scripts.find((s) => s.id === draft.id) : undefined;
  const dirty =
    !draft ||
    !persisted ||
    draft.name !== persisted.name ||
    draft.language !== persisted.language ||
    draft.code !== persisted.code ||
    draft.intervalMin !== persisted.intervalMin;

  return (
    <Page>
      <PageHeader
        title="Scripts"
        subtitle={SUBTITLE}
        actions={
          <button
            onClick={() => {
              setDraft(blankDraft());
              setOutput(null);
            }}
            className="flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500"
          >
            <Plus size={16} /> New script
          </button>
        }
      />
      <div className="mt-4 flex gap-4">
        <aside className="w-64 shrink-0">
          {scripts.length === 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-500">
              No scripts yet. Create one to get started.
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {scripts.map((s) => (
                <li key={s.id}>
                  <ScriptRow
                    script={s}
                    selected={draft?.id === s.id}
                    lastRun={runs[s.id]}
                    onSelect={() => {
                      setDraft(s);
                      setOutput(null);
                    }}
                    onToggleRun={() =>
                      toggle.mutate({ ...s, enabled: !s.enabled })
                    }
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 border-t border-zinc-800 pt-3">
            <button
              onClick={() => setExamplesOpen((v) => !v)}
              className="flex w-full items-center gap-1 text-xs font-medium uppercase tracking-wide text-zinc-400 hover:text-zinc-200"
            >
              {examplesOpen ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
              Examples
            </button>
            {examplesOpen ? (
              <ul className="mt-2 flex flex-col gap-1.5">
                {(examplesQ.data ?? []).map((ex) => (
                  <li key={ex.id}>
                    <button
                      onClick={() => {
                        setDraft({
                          id: "",
                          name: ex.name,
                          language: ex.language,
                          code: ex.code,
                          intervalMin: null,
                          enabled: false,
                          updatedAt: 0,
                        });
                        setOutput(null);
                      }}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-zinc-800/60"
                    >
                      {ex.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          {draft ? (
            <Editor
              draft={draft}
              onChange={setDraft}
              onRun={() => run.mutate(draft)}
              onSave={() => save.mutate(draft)}
              onDelete={draft.id ? () => remove.mutate(draft.id) : undefined}
              running={run.isPending}
              saving={save.isPending}
              output={output}
              dirty={dirty}
            />
          ) : (
            <Centered>Select a script, or create a new one.</Centered>
          )}
        </section>
      </div>
    </Page>
  );
}

function ScriptRow({
  script,
  selected,
  lastRun,
  onSelect,
  onToggleRun,
}: {
  script: Script;
  selected: boolean;
  lastRun: ScriptRunState | undefined;
  onSelect: () => void;
  onToggleRun: () => void;
}) {
  const canLoop = script.intervalMin != null;
  const running = script.enabled && canLoop;
  return (
    <div
      className={`flex items-stretch overflow-hidden rounded-lg border transition ${
        selected
          ? "border-indigo-600 bg-indigo-950/40"
          : "border-zinc-800 bg-zinc-900/40 hover:bg-zinc-800/60"
      }`}
    >
      <button onClick={onSelect} className="min-w-0 flex-1 px-3 py-2 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm text-zinc-100">{script.name}</span>
          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
            {LANGUAGE_LABEL[script.language]}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
          {running ? (
            <span className="flex items-center gap-1 text-emerald-400">
              <Play size={11} /> running · every {script.intervalMin}m
            </span>
          ) : canLoop ? (
            <span>stopped · every {script.intervalMin}m</span>
          ) : (
            <span>manual</span>
          )}
          {lastRun ? (
            <span
              className={lastRun.run.ok ? "text-emerald-400" : "text-red-400"}
            >
              • last {lastRun.run.ok ? "ok" : "error"}
            </span>
          ) : null}
        </div>
      </button>
      {canLoop ? (
        <button
          onClick={onToggleRun}
          title={running ? "Stop the loop" : "Start the loop"}
          aria-label={running ? "Stop the loop" : "Start the loop"}
          className={`flex shrink-0 items-center border-l px-2.5 transition ${
            running
              ? "border-red-900/60 text-red-400 hover:bg-red-950/40"
              : "border-zinc-800 text-emerald-400 hover:bg-emerald-950/30"
          }`}
        >
          {running ? <Square size={14} /> : <Play size={14} />}
        </button>
      ) : null}
    </div>
  );
}

function Editor({
  draft,
  onChange,
  onRun,
  onSave,
  onDelete,
  running,
  saving,
  output,
  dirty,
}: {
  draft: Script;
  onChange: (s: Script) => void;
  onRun: () => void;
  onSave: () => void;
  onDelete?: () => void;
  running: boolean;
  saving: boolean;
  output: ScriptRun | null;
  dirty: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Name
          <input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            className="w-56 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Language
          <select
            value={draft.language}
            onChange={(e) => {
              const language = e.target.value as ScriptLanguage;
              // Swap in the language's example only when the code is still an
              // untouched starter (or empty), never clobbering real edits.
              const untouched =
                draft.code.trim() === "" ||
                Object.values(STARTER).includes(draft.code);
              onChange({
                ...draft,
                language,
                code: untouched ? STARTER[language] : draft.code,
              });
            }}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
          >
            <option value="rhai">Rhai</option>
            <option value="js">JavaScript</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Loop every (minutes)
          <input
            type="number"
            min={1}
            placeholder="manual"
            value={draft.intervalMin ?? ""}
            onChange={(e) => {
              const n =
                e.target.value === ""
                  ? null
                  : Math.max(1, Number(e.target.value));
              onChange({
                ...draft,
                intervalMin: n,
                enabled: n == null ? false : draft.enabled,
              });
            }}
            className="w-28 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
          />
        </label>
        <label className="flex items-center gap-1.5 pb-1.5 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={draft.intervalMin == null || dirty}
            onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
          />
          Loop armed
        </label>
        {dirty && draft.intervalMin != null ? (
          <span className="pb-1.5 text-xs text-amber-400">
            Save your changes to arm the loop — it always runs the saved code.
          </span>
        ) : null}
      </div>

      <CodeEditor
        value={draft.code}
        onChange={(code) => onChange({ ...draft, code })}
      />

      <div className="flex items-center gap-2">
        <button
          onClick={onRun}
          disabled={running}
          className="flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          <Play size={16} /> {running ? "Running…" : "Run"}
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
        >
          <Save size={16} /> Save
        </button>
        {onDelete ? (
          <button
            onClick={onDelete}
            className="ml-auto flex items-center gap-1.5 rounded border border-red-900 px-3 py-1.5 text-sm text-red-300 transition hover:bg-red-950/50"
          >
            <Trash2 size={16} /> Delete
          </button>
        ) : null}
      </div>

      {output ? <RunOutput output={output} /> : null}
    </div>
  );
}

function RunOutput({ output }: { output: ScriptRun }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`rounded px-1.5 py-0.5 uppercase tracking-wide ${
            output.ok
              ? "bg-emerald-950 text-emerald-300"
              : "bg-red-950 text-red-300"
          }`}
        >
          {output.ok ? "ok" : "error"}
        </span>
        <span className="text-zinc-500">{output.durationMs} ms</span>
      </div>
      {output.error ? (
        <pre className="mt-2 whitespace-pre-wrap text-sm text-red-300">
          {output.error}
        </pre>
      ) : (
        <pre className="mt-2 whitespace-pre-wrap font-mono text-sm text-zinc-200">
          {JSON.stringify(output.result, null, 2)}
        </pre>
      )}
      {output.logs.length > 0 ? (
        <div className="mt-3">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">
            Logs
          </div>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-zinc-400">
            {output.logs.join("\n")}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
