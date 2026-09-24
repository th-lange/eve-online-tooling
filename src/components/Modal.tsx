import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Elements a focus trap treats as reachable via Tab. Excludes disabled
 *  controls and explicitly untabbable (`tabindex="-1"`) elements. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** "dialog" blocks interaction with the rest of the page (forms,
   *  confirmations). "alertdialog" suits a time-sensitive notification that
   *  still needs dismissible a11y semantics. Defaults to "dialog". */
  role?: "dialog" | "alertdialog";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Classes for the panel element itself — this is where positioning
   *  (centered, anchored dropdown, etc.) and box styling both live. */
  className?: string;
  /** Render a click-away backdrop behind the panel. Default true. */
  backdrop?: boolean;
  /** Classes for the backdrop element. Default is an invisible full-viewport
   *  click-catcher; pass a `bg-black/…` class to dim the page. */
  backdropClassName?: string;
  /** Close when the backdrop is clicked. Default true; ignored if
   *  `backdrop` is false. */
  closeOnBackdropClick?: boolean;
  /** Render into `document.body` via a portal. Default true — set false for
   *  a popover anchored to a `position: relative` ancestor, since a portal
   *  would break that positioning context. */
  portal?: boolean;
}

/**
 * Shared modal/popover wrapper enforcing WCAG 2.1 AA overlay semantics:
 * `role="dialog"` (or `"alertdialog"`), Escape-to-close, a focus trap that
 * cycles Tab/Shift+Tab within the panel and restores focus to the trigger on
 * close, and an optional click-away backdrop. Used by `PriceHistoryPopover`,
 * the Fitting optimizer popover, and the Fight Overlay panel — extracted
 * from `PriceHistoryPopover` (#838) so there is exactly one implementation
 * of this logic.
 */
export function Modal({
  open,
  onClose,
  children,
  role = "dialog",
  className,
  backdrop = true,
  backdropClassName = "fixed inset-0 z-40",
  closeOnBackdropClick = true,
  portal = true,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus trap: on open, remember what had focus and move focus into the
  // panel; while open, Tab/Shift+Tab cycle within the panel's focusable
  // elements instead of escaping to the page; on close, restore focus to
  // whatever triggered the modal.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const firstFocusable =
      panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const content = (
    <>
      {backdrop && (
        <div
          className={backdropClassName}
          onClick={closeOnBackdropClick ? onClose : undefined}
        />
      )}
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        className={className}
      >
        {children}
      </div>
    </>
  );

  return portal ? createPortal(content, document.body) : content;
}
