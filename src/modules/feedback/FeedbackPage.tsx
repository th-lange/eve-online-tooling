import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bug,
  ExternalLink,
  Lightbulb,
  MessageSquare,
  Star,
  Trash2,
} from "lucide-react";
import {
  activeCharacter,
  authCharacters,
  errorMessage,
  feedbackForget,
  feedbackHistory,
  feedbackPreview,
  feedbackRetryPending,
  feedbackStatus,
  feedbackSubmit,
  githubIssueUrl,
  type FeedbackDraft,
  type FeedbackEntry,
  type FeedbackKind,
} from "../../lib/api";
import { Page, PageHeader } from "../../components/page";
import { modules } from "../registry";

// Note on the `modules` import: registry.ts imports this component, so the two
// files form an import cycle. That is safe *as long as* `modules` is only read
// during render (by which point registry.ts has finished evaluating and the
// live binding is populated) and never at module top level. `categories()`
// below is called from inside the component for exactly that reason.

const GENERAL = "general";

/** Feedback categories: every registered module, plus "not about one module".
 *  Derived from the registry so a new module needs no edit here. */
function categories(): { id: string; title: string }[] {
  const fromRegistry = modules
    .map((m) => ({ id: m.id, title: m.title }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return [
    { id: GENERAL, title: "General (not about one module)" },
    ...fromRegistry,
  ];
}

const KINDS: {
  id: FeedbackKind;
  label: string;
  icon: typeof Bug;
  hint: string;
}[] = [
  {
    id: "rating",
    label: "Rating",
    icon: Star,
    hint: "How well does this work for you? Stars are enough; words are a bonus.",
  },
  {
    id: "bug",
    label: "Bug",
    icon: Bug,
    hint: "What did you do, what happened, and what did you expect instead?",
  },
  {
    id: "feature",
    label: "Idea",
    icon: Lightbulb,
    hint: "What would you like the app to do that it doesn't do today?",
  },
];

/** Clickable 1–5 star row. */
function StarPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          aria-label={`${n} ${n === 1 ? "star" : "stars"}`}
          aria-pressed={value === n}
          className="rounded p-1 transition hover:bg-zinc-800"
        >
          <Star
            size={22}
            className={
              n <= value ? "fill-amber-400 text-amber-400" : "text-zinc-600"
            }
          />
        </button>
      ))}
    </div>
  );
}

function StatusPill({ entry }: { entry: FeedbackEntry }) {
  const sent = entry.status === "sent";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] ${
        sent
          ? "bg-emerald-900/50 text-emerald-300"
          : "bg-amber-900/50 text-amber-300"
      }`}
    >
      {sent ? "sent" : "queued"}
    </span>
  );
}

export function FeedbackPage() {
  const qc = useQueryClient();
  const cats = useMemo(categories, []);

  const [kind, setKind] = useState<FeedbackKind>("rating");
  const [moduleId, setModuleId] = useState(GENERAL);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  // `undefined` means "the user hasn't chosen" — the active character is the
  // default until they do. `null` is the deliberate "stay anonymous" choice, so
  // the two cannot be conflated.
  const [chosenCharacter, setChosenCharacter] = useState<
    number | null | undefined
  >(undefined);
  const [showPayload, setShowPayload] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<FeedbackEntry | null>(null);

  const status = useQuery({
    queryKey: ["feedback", "status"],
    queryFn: feedbackStatus,
  });
  const characters = useQuery({
    queryKey: ["auth", "characters"],
    queryFn: authCharacters,
  });
  const activeChar = useQuery({
    queryKey: ["auth", "active"],
    queryFn: activeCharacter,
  });

  const roster = characters.data ?? [];
  const defaultCharacter = activeChar.data ?? roster[0]?.characterId ?? null;
  const characterId =
    chosenCharacter === undefined ? defaultCharacter : chosenCharacter;

  const draft: FeedbackDraft = {
    kind,
    module: moduleId,
    // Stars only mean something on a rating; other kinds send 0.
    rating: kind === "rating" ? rating : 0,
    body,
    characterId,
  };

  // Opening the page is also when we flush anything that failed to send while
  // the user was offline — but only on a build that can send at all, otherwise
  // that is a guaranteed round of failures for no reason.
  const history = useQuery({
    queryKey: ["feedback", "history"],
    queryFn: () =>
      status.data?.configured ? feedbackRetryPending() : feedbackHistory(),
    enabled: status.isSuccess,
  });

  // The preview is the *same* record the submit will upload — it comes from the
  // backend rather than being reassembled here, so it can't drift from what is
  // actually sent.
  const preview = useQuery({
    queryKey: ["feedback", "preview", draft],
    queryFn: () => feedbackPreview(draft),
    enabled: showPayload,
  });

  const submit = useMutation({
    mutationFn: () => feedbackSubmit(draft),
    onSuccess: (entry) => {
      setSent(entry);
      setError(null);
      setBody("");
      setRating(0);
      qc.invalidateQueries({ queryKey: ["feedback"] });
    },
    onError: (e) => {
      setSent(null);
      setError(errorMessage(e));
    },
  });

  const forget = useMutation({
    mutationFn: feedbackForget,
    onSuccess: (entries) => qc.setQueryData(["feedback", "history"], entries),
  });

  const activeKind = KINDS.find((k) => k.id === kind)!;
  const configured = status.data?.configured ?? true;
  const cooldown = status.data?.cooldownSecs ?? 0;
  const moduleTitle = cats.find((c) => c.id === moduleId)?.title ?? moduleId;
  const canSubmit =
    !submit.isPending &&
    configured &&
    // Until the roster has loaded the reply-to defaults to null, so a fast
    // click would quietly send anonymously — wait for it rather than guess.
    characters.isSuccess &&
    (kind === "rating" ? rating > 0 : body.trim().length > 0);

  // Inactive without a logged-in character. The nav already leaves the module
  // out in that state, so this is what a direct route or a restored
  // "last visited" lands on — and what the user sees the moment they remove
  // their last character while the page is open.
  if (status.isSuccess && !status.data.active) {
    return (
      <Page width="narrow">
        <PageHeader
          title={
            <>
              <MessageSquare size={22} className="text-zinc-500" /> Feedback
            </>
          }
        />
        <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
          <p className="font-medium text-zinc-300">
            Module inactive — registered account required
          </p>
          <p className="mt-2 leading-relaxed">
            Feedback is tied to a character, so a report can be answered by EVE
            mail in-game. Add a character with <strong>Add</strong> under
            Character in the sidebar and this module comes back.
          </p>
        </div>
      </Page>
    );
  }

  return (
    <Page width="narrow">
      <PageHeader
        title={
          <>
            <MessageSquare size={22} className="text-sky-400" /> Feedback
          </>
        }
        subtitle="Rate a module, report a bug, or ask for something new. Goes straight to the maintainer — nobody else can read it."
      />

      {!configured && (
        <div className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-sm text-amber-200">
          This build has no feedback endpoint configured, so sending is off. You
          can still file it on GitHub — the button below carries your text over.
        </div>
      )}

      <div className="mt-6 space-y-5">
        <div className="flex gap-2">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => {
                setKind(k.id);
                setSent(null);
                setError(null);
              }}
              aria-pressed={kind === k.id}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                kind === k.id
                  ? "border-sky-700 bg-sky-950/40 text-sky-200"
                  : "border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <k.icon size={16} />
              {k.label}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Which part of the app?
          <select
            value={moduleId}
            onChange={(e) => setModuleId(e.currentTarget.value)}
            className="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none"
          >
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>

        {kind === "rating" && (
          <div className="flex flex-col gap-1 text-xs text-zinc-400">
            Your rating
            <StarPicker value={rating} onChange={setRating} />
          </div>
        )}

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {kind === "rating"
            ? "Anything to add? (optional)"
            : "Tell us about it"}
          <textarea
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            rows={6}
            maxLength={4000}
            placeholder={activeKind.hint}
            className="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <span className="self-end text-[11px] text-zinc-600">
            {body.length} / 4000
          </span>
        </label>

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Reply to me as
          <select
            value={characterId ?? ""}
            onChange={(e) =>
              setChosenCharacter(
                e.currentTarget.value === ""
                  ? null
                  : Number(e.currentTarget.value),
              )
            }
            className="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none"
          >
            {roster.map((c) => (
              <option key={c.characterId} value={c.characterId}>
                {c.name}
              </option>
            ))}
            <option value="">Don't include a character (anonymous)</option>
          </select>
          <span className="text-[11px] text-zinc-600">
            Only the name is sent, and only so I can reply by EVE mail in-game.
          </span>
        </label>

        <div>
          <button
            type="button"
            onClick={() => setShowPayload((v) => !v)}
            className="text-xs text-zinc-400 underline hover:text-zinc-200"
          >
            {showPayload ? "Hide" : "Show"} exactly what gets sent
          </button>
          {showPayload && (
            <pre className="mt-2 overflow-x-auto rounded bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-400">
              {preview.isPending
                ? "…"
                : preview.error
                  ? errorMessage(preview.error)
                  : JSON.stringify(preview.data, null, 2)}
            </pre>
          )}
        </div>

        {error && (
          <div className="rounded border border-rose-900/60 bg-rose-950/30 p-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        {sent && (
          <div className="rounded border border-emerald-900/60 bg-emerald-950/30 p-3 text-sm text-emerald-200">
            {sent.status === "sent" ? (
              <>
                Thank you — sent.{" "}
                {sent.docId && (
                  <span className="text-emerald-400/70">
                    Reference <code>{sent.docId}</code>.
                  </span>
                )}
              </>
            ) : (
              <>
                Saved. It couldn't be delivered right now, so it's queued and
                will go out next time you open this page.
              </>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => submit.mutate()}
            className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {submit.isPending ? "Sending…" : "Send feedback"}
          </button>
          {kind !== "rating" && (
            <a
              href={githubIssueUrl(
                draft,
                status.data?.appVersion ?? "",
                moduleTitle,
              )}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-zinc-400 underline hover:text-zinc-200"
            >
              File on GitHub instead <ExternalLink size={12} />
            </a>
          )}
          {cooldown > 0 && (
            <span className="text-xs text-zinc-500">
              You can send again in {cooldown}s.
            </span>
          )}
        </div>
      </div>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-zinc-300">
          What you've sent from this machine
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          Kept locally, for your reference. Submissions can't be read back — not
          by you, and not by the app — so this list is the only copy you have.
          Removing a row here doesn't recall the submission.
        </p>
        {history.data && history.data.length > 0 ? (
          <ul className="mt-3 divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {history.data.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start gap-3 px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-300">{entry.payload.kind}</span>
                    <span className="text-zinc-600">·</span>
                    <span className="text-zinc-500">
                      {entry.payload.module}
                    </span>
                    {entry.payload.rating > 0 && (
                      <span className="text-amber-400">
                        {"★".repeat(entry.payload.rating)}
                      </span>
                    )}
                    <StatusPill entry={entry} />
                  </div>
                  {entry.payload.body && (
                    <p className="mt-1 truncate text-zinc-500">
                      {entry.payload.body}
                    </p>
                  )}
                  {entry.status === "pending" && entry.error && (
                    <p className="mt-1 text-amber-500/80">{entry.error}</p>
                  )}
                </div>
                <span className="shrink-0 text-zinc-600">
                  {new Date(entry.submittedAt * 1000).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  onClick={() => forget.mutate(entry.id)}
                  aria-label="Remove from this list"
                  className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-zinc-600">Nothing yet.</p>
        )}
      </section>
    </Page>
  );
}
