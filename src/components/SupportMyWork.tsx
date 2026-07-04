import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, ExternalLink, Heart, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { useCopyToClipboard } from "../lib/useCopyToClipboard";

// EVE content-creator code (placeholder until CCP finishes processing it) and
// the buddy / referral sign-up link. Surfaced once on first launch and, after
// that, in the collapsible "Support my work" panel in the sidebar.
export const CREATOR_CODE = "-----";
export const REFERRAL_URL =
  "https://www.eveonline.com/signup?invc=c2926a85-e10f-4522-9245-0d8364eacb86";

function openExternal(url: string) {
  void openUrl(url).catch(() => {});
}

/** A labelled value with a copy button (creator code, etc.). */
export function CopyRow({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
        {note && <span className="ml-1 normal-case text-zinc-600">{note}</span>}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <code className="flex-1 truncate rounded bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300">
          {value}
        </code>
        <button
          onClick={() => copy(value)}
          title="Copy"
          aria-label={`Copy ${label}`}
          className="shrink-0 rounded p-1 text-zinc-500 hover:text-zinc-200"
        >
          {copied ? (
            <Check size={13} className="text-emerald-400" />
          ) : (
            <Copy size={13} />
          )}
        </button>
      </div>
    </div>
  );
}

/** The buddy invite link: a big "sign up" button plus a copy control. */
export function LinkRow() {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        Buddy invite link
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <button
          onClick={() => openExternal(REFERRAL_URL)}
          className="flex flex-1 items-center justify-center gap-1.5 truncate rounded bg-indigo-600 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500"
        >
          <ExternalLink size={12} className="shrink-0" /> Sign up with my link
        </button>
        <button
          onClick={() => copy(REFERRAL_URL)}
          title="Copy invite link"
          aria-label="Copy invite link"
          className="shrink-0 rounded p-1 text-zinc-500 hover:text-zinc-200"
        >
          {copied ? (
            <Check size={13} className="text-emerald-400" />
          ) : (
            <Copy size={13} />
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * First-launch overlay introducing the support links. Shown once, then never
 * again (dismissal persisted); the sidebar panel keeps the links available.
 */
export function SupportModal() {
  const [open, setOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.supportSeen) !== "1",
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismiss();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  const dismiss = () => {
    localStorage.setItem(STORAGE_KEYS.supportSeen, "1");
    setOpen(false);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      onClick={dismiss}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div
        role="dialog"
        onClick={(e) => e.stopPropagation()}
        className="relative z-10 w-[440px] max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <Heart size={18} className="text-rose-400" /> Support my work
          </h2>
          <button
            onClick={dismiss}
            aria-label="Close"
            className="text-zinc-500 hover:text-zinc-200"
          >
            <X size={16} />
          </button>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          This app is free and made in my spare time. If it's useful and you (or
          a friend) are creating a new EVE account, using my buddy link or
          creator code below throws a few coins my way — at no cost to you. o7
        </p>

        <CopyRow label="Creator code" value={CREATOR_CODE} note="(pending)" />
        <LinkRow />

        <p className="mt-4 text-xs leading-relaxed text-zinc-500">
          These links also live in the <strong>Support my work</strong> section
          in the sidebar — you can hide it any time if you'd rather not see it.
          It&apos;d make me sad, just so you know.
        </p>

        <div className="mt-4 flex justify-end">
          <button
            onClick={dismiss}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
