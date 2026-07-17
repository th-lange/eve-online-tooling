/**
 * A label/value stat tile, used in page header summary rows (wallet totals,
 * price history highlights, asset value, …). `accent` is a Tailwind
 * text-color class for the value (defaults to zinc); `boxed` adds the
 * rounded border/bg wrapper some pages use to set their stats apart from the
 * surrounding row.
 */
export function Stat({
  label,
  value,
  accent = "text-zinc-200",
  boxed,
}: {
  label: string;
  value: string;
  accent?: string;
  boxed?: boolean;
}) {
  const body = (
    <>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`tabular-nums ${accent}`}>{value}</div>
    </>
  );
  return boxed ? (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      {body}
    </div>
  ) : (
    <div>{body}</div>
  );
}
