import type { ReactNode } from "react";
import { errorMessage, isAuthRequired } from "../lib/api";

/**
 * Text-only version of the auth-required vs generic-error branch, for call
 * sites that need a plain string (tooltip titles, inline messages) rather
 * than JSX. Returns `null` when there's no error.
 */
// Plain text helper colocated with its JSX counterpart; both wrap the same
// isAuthRequired/errorMessage branch.
// eslint-disable-next-line react-refresh/only-export-components
export function queryErrorText(
  error: unknown,
  loginMessage = "Log in a character first.",
): string | null {
  if (!error) return null;
  return isAuthRequired(error) ? loginMessage : errorMessage(error);
}

/**
 * Shared "log in a character" vs "the request failed" notice for
 * character-data queries (#337, #571). Renders nothing when there's no
 * error, a muted login prompt when `isAuthRequired(error)`, otherwise the
 * error message in red with an optional scope hint below it.
 */
export function QueryErrorNotice({
  error,
  loginMessage = "Log in a character first.",
  scopeHint,
  className = "mt-3 text-sm",
}: {
  error: unknown;
  loginMessage?: string;
  scopeHint?: ReactNode;
  className?: string;
}) {
  if (!error) return null;
  if (isAuthRequired(error)) {
    return <div className={`${className} text-zinc-400`}>{loginMessage}</div>;
  }
  return (
    <div className={`${className} text-rose-400`}>
      {errorMessage(error)}
      {scopeHint && (
        <div className="mt-1 text-xs text-zinc-500">{scopeHint}</div>
      )}
    </div>
  );
}
