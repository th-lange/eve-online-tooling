import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Modal } from "../../components/Modal";
import { useConfirmBeforeQuit } from "./useConfirmBeforeQuit";

/**
 * Root-level provider: asks before the main window actually closes, gated by
 * the "Confirm before quit" setting (Settings page). Mounted once at the app
 * root, same pattern as `FwHomeDefenseProvider`/`FightOverlayProvider`.
 *
 * Tauri's `onCloseRequested` fires before the OS close happens and lets a
 * handler call `event.preventDefault()` to cancel it — that's the only hook
 * point; there's no React-level "are you sure" step the native title-bar
 * close button goes through otherwise. The setting is read through a ref
 * (not the state directly) so the listener — registered once on mount —
 * always sees the latest value instead of whatever was current when it was
 * first attached.
 *
 * Pressing the window's close button a second time while the prompt is
 * already up is treated as confirmation: the second `onCloseRequested`
 * quits immediately (`destroy()`), so an impatient double-press on close
 * does the obvious thing instead of silently doing nothing.
 */
export function ConfirmQuitProvider({ children }: { children: ReactNode }) {
  const [confirmBeforeQuit] = useConfirmBeforeQuit();
  const confirmBeforeQuitRef = useRef(confirmBeforeQuit);
  confirmBeforeQuitRef.current = confirmBeforeQuit;
  const [showConfirm, setShowConfirm] = useState(false);
  // The close listener is registered once on mount and reads live state
  // through refs; this one lets a repeat close-request short-circuit to quit.
  const showConfirmRef = useRef(showConfirm);
  showConfirmRef.current = showConfirm;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (!confirmBeforeQuitRef.current) return;
        event.preventDefault();
        // Already asking → a second close press means "yes, quit".
        if (showConfirmRef.current) {
          void getCurrentWindow().destroy();
          return;
        }
        setShowConfirm(true);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not running under Tauri (e.g. a browser-only dev preview) —
        // nothing to intercept, the setting just has no effect.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <>
      {children}
      <Modal
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        role="alertdialog"
        aria-label="Confirm quit"
        className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
      >
        <h2 className="text-sm font-semibold text-zinc-100">
          Quit EVE Online Tooling?
        </h2>
        <p className="mt-2 text-xs text-zinc-400">
          Any in-progress, unsaved edits in open modules will be lost.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowConfirm(false)}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            // destroy(), not close() — close() would re-raise this same
            // onCloseRequested event and loop back into this prompt.
            onClick={() => void getCurrentWindow().destroy()}
            className="rounded bg-rose-700 px-3 py-1.5 text-sm text-white hover:bg-rose-600"
          >
            Quit
          </button>
        </div>
      </Modal>
    </>
  );
}
