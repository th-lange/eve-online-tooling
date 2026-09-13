/**
 * Small inline error line for mutation/catch handlers that aren't backed by a
 * react-query error object (see `QueryErrorNotice` for that case). Renders
 * nothing when `message` is falsy, so a call site can wire it straight to
 * local error state — set on failure, cleared on the next successful
 * attempt (#820: replaces `alert()` in mutation/catch handlers).
 */
export function InlineError({
  message,
  className = "mt-2 text-sm text-rose-400",
}: {
  message: string | null | undefined;
  className?: string;
}) {
  if (!message) return null;
  return <div className={className}>{message}</div>;
}
