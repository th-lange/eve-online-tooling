/**
 * A tiny inline-SVG sparkline for a numeric series (e.g. a market price trend).
 * Renders nothing useful below two points. Colour defaults to the sign of the
 * first→last move (green up, rose down, zinc flat) but can be overridden.
 */
export function Sparkline({
  values,
  width = 64,
  height = 18,
  color,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
}) {
  if (values.length < 2) {
    return <span className="text-zinc-600">—</span>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  // Flip Y: SVG y grows downward, so a high value sits near the top.
  const points = values
    .map(
      (v, i) =>
        `${(i * step).toFixed(2)},${(height - ((v - min) / span) * height).toFixed(2)}`,
    )
    .join(" ");
  const stroke =
    color ??
    (values[values.length - 1] > values[0]
      ? "#34d399"
      : values[values.length - 1] < values[0]
        ? "#fb7185"
        : "#71717a");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      aria-hidden
      className={className}
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
