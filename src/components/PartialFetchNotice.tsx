import { TriangleAlert } from "lucide-react";

/**
 * Warning shown when an "All characters" aggregation skipped characters whose
 * ESI fetch failed (#1169), so a partial list/total isn't mistaken for the
 * complete one. Icon + text, never colour alone. Renders nothing when no
 * character failed.
 */
export function PartialFetchNotice({
  failed,
  className = "mt-3",
}: {
  failed: readonly string[] | null | undefined;
  className?: string;
}) {
  if (!failed || failed.length === 0) return null;
  return (
    <div
      role="status"
      className={`${className} flex items-start gap-2 text-sm text-amber-400`}
    >
      <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>Couldn't load {failed.join(", ")} — showing the rest.</span>
    </div>
  );
}
