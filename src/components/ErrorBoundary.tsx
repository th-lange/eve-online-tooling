import { Component, type ErrorInfo, type ReactNode } from "react";
import { useRouteError } from "react-router-dom";
import * as Sentry from "@sentry/react";
import { errorMessage } from "../lib/api/common";

/** The card shown in place of a crashed page: what happened plus a way out. */
function CrashCard({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="m-6 max-w-xl rounded border border-rose-900 bg-rose-950/30 p-4"
    >
      <h2 className="text-sm font-medium text-rose-300">{title} crashed</h2>
      <p className="mt-1 break-words text-xs text-zinc-400">
        {errorMessage(error)}
      </p>
      <p className="mt-2 text-xs text-zinc-500">
        The rest of the app is unaffected. The error was recorded on the Logs
        page.
      </p>
      <div className="mt-3 flex gap-2">
        {onRetry && (
          <button
            onClick={onRetry}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            Reload module
          </button>
        )}
        <button
          onClick={() => window.location.assign("/")}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
        >
          Go to start
        </button>
      </div>
    </div>
  );
}

/**
 * Isolates one module page: a render error there shows a recovery card instead
 * of unmounting the whole shell (sidebar, every other kept-alive page and its
 * in-memory state). Reported to the Logs page (via `console.error`, which the
 * log capture records) and to Sentry when enabled (#1195).
 */
export class ModuleErrorBoundary extends Component<
  { moduleId: string; title: string; children: ReactNode },
  { error: unknown; failed: boolean }
> {
  state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(
      `Module "${this.props.moduleId}" crashed: ${errorMessage(error)}`,
      info.componentStack ?? "",
    );
    Sentry.captureException(error, {
      extra: { moduleId: this.props.moduleId },
    });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <CrashCard
        title={this.props.title}
        error={this.state.error}
        onRetry={() => this.setState({ error: null, failed: false })}
      />
    );
  }
}

/** Root route `errorElement`: replaces React Router's raw stack-trace screen. */
export function RootErrorPage() {
  const error = useRouteError();
  return <CrashCard title="The app" error={error} />;
}
