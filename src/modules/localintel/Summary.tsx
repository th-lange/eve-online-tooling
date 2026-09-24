import { formatInt } from "../../lib/format";
import type { LocalScanResult } from "../../lib/api";

export function Summary({ result }: { result: LocalScanResult }) {
  return (
    <div className="mt-4 flex items-center gap-4 text-sm">
      <span className="text-zinc-300">
        {formatInt(result.pilots.length)} pilots
      </span>
      <span className="text-rose-400">{formatInt(result.reds)} red</span>
      <span className="text-zinc-400">
        {formatInt(result.neutrals)} neutral
      </span>
      <span className="text-sky-400">{formatInt(result.blues)} blue</span>
    </div>
  );
}
