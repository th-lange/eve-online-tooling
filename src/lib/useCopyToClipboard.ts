import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fire-and-forget clipboard write. Safe when the Clipboard API is unavailable
 * (older webviews) or the user denies access: it's a no-op and never throws.
 * Use this outside components / when you don't need a "copied" acknowledgement;
 * use {@link useCopyToClipboard} when you do.
 */
export function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/**
 * Copy text to the clipboard with a transient "copied" acknowledgement.
 *
 * `copied` holds the tag of the most recent copy (or `true` when no tag is
 * given) for `resetMs`, then clears — drive a ✓/label swap off it. Pass a tag
 * to tell apart multiple copy buttons in one component (e.g. `copy(md, "md")`
 * then check `copied === "md"`). Safe when the Clipboard API is unavailable
 * (older webviews): the write is a no-op and never throws.
 */
export function useCopyToClipboard(resetMs = 1200) {
  const [copied, setCopied] = useState<string | boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    (text: string, tag: string | boolean = true) => {
      copyToClipboard(text);
      setCopied(tag);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), resetMs);
    },
    [resetMs],
  );

  return { copied, copy };
}
