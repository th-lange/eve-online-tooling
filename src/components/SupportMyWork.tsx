import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, ExternalLink, Heart, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { useCopyToClipboard } from "../lib/useCopyToClipboard";
import { errorMessage, openInfoWindow } from "../lib/api";
import { PrimaryButton } from "./page";

// EVE buddy / referral sign-up link. Surfaced once on first launch and, after
// that, in the collapsible "Support my work" panel in the sidebar.
export const REFERRAL_URL =
  "https://www.eveonline.com/signup?invc=c2926a85-e10f-4522-9245-0d8364eacb86";
// Corp id for the in-game "Show Info" window, so players can send an ISK
// donation straight from the corp panel's "Give Money" action.
export const CORP_ID = 98_463_993;

function openExternal(url: string) {
  void openUrl(url).catch(() => {});
}

/** Creator code: on hold — Fenris (who run CCP's creator program) didn't
 *  grant one, so there's nothing to copy yet. The row stays so people know
 *  it's deliberate, not broken. */
export function CreatorCodeRow() {
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        Creator code
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
        On hold — the fucks at Fenris did not grant me one. The buddy link below
        works regardless.
      </p>
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

/** In-game donation: opens the corp's "Show Info" window (its "Give Money"
 *  action lets a player send ISK directly) — needs a logged-in character with
 *  the esi-ui.open_window scope. ESI accepts the call even when that
 *  character isn't in-game (nothing visibly happens), so the result line
 *  spells out where the window opens instead of failing silently. */
export function CorpRow() {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        Donate ISK in-game
      </div>
      <button
        onClick={() => {
          setStatus(null);
          openInfoWindow(CORP_ID)
            .then(() =>
              setStatus({
                ok: true,
                text: 'Sent. The Show Info window opens on your active character\'s game client — that character must be logged in-game. Donate via its "Give Money" action.',
              }),
            )
            .catch((e) =>
              setStatus({
                ok: false,
                text: `Couldn't open it: ${errorMessage(e)}. If this character logged in before the open-window permission existed, log them in again.`,
              }),
            );
        }}
        className="mt-1 flex w-full items-center justify-center gap-1.5 truncate rounded bg-indigo-600 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500"
      >
        <ExternalLink size={12} className="shrink-0" /> Support my corp
      </button>
      {status && (
        <p
          className={`mt-1 text-[11px] leading-relaxed ${
            status.ok ? "text-zinc-500" : "text-rose-400"
          }`}
        >
          {status.text}
        </p>
      )}
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

        <CreatorCodeRow />
        <LinkRow />
        <CorpRow />

        <p className="mt-4 text-xs leading-relaxed text-zinc-500">
          These links also live in the <strong>Support my work</strong> section
          in the sidebar — you can hide it any time if you'd rather not see it.
          It&apos;d make me sad, just so you know.
        </p>

        <div className="mt-4 flex justify-end">
          <PrimaryButton onClick={dismiss}>Got it</PrimaryButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
