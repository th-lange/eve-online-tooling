import { useMemo } from "react";
import type { DepthLevel } from "../lib/api";
import { formatInt, formatIsk } from "../lib/format";

// Market-depth chart: two cumulative curves sharing a volume axis. The buy
// curve (emerald) accumulates demand from the highest bid downward; the sell
// curve (rose) accumulates supply from the lowest ask upward. They rise away
// from the spread in the middle — a steep wall means thin liquidity there.

const W = 640;
const H = 200;
const PAD_X = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

/** Running total of `volume` across levels, paired with each level's price. */
function cumulative(levels: DepthLevel[]): { price: number; total: number }[] {
  let total = 0;
  return levels.map((l) => {
    total += l.volume;
    return { price: l.price, total };
  });
}

export function DepthChart({
  sell,
  buy,
}: {
  sell: DepthLevel[];
  buy: DepthLevel[];
}) {
  const model = useMemo(() => {
    // Sell is ascending, buy descending (as the backend returns them). The buy
    // curve reads left-to-right by ascending price, so reverse it for plotting.
    const sellCum = cumulative(sell);
    const buyCum = cumulative(buy);
    const prices = [...sell, ...buy].map((l) => l.price);
    if (prices.length === 0) return null;
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const spanP = maxP - minP || 1;
    const maxVol =
      Math.max(
        sellCum.length ? sellCum[sellCum.length - 1].total : 0,
        buyCum.length ? buyCum[buyCum.length - 1].total : 0,
      ) || 1;
    const x = (price: number) =>
      PAD_X + ((price - minP) / spanP) * (W - 2 * PAD_X);
    const y = (vol: number) =>
      H - PAD_BOTTOM - (vol / maxVol) * (H - PAD_TOP - PAD_BOTTOM);
    // Buy curve plotted by ascending price (reverse of the descending input) so
    // its wall rises toward the spread from the left.
    const buyAsc = [...buyCum].reverse();
    const toPts = (pts: { price: number; total: number }[]) =>
      pts.map((p) => `${x(p.price).toFixed(1)},${y(p.total).toFixed(1)}`);
    const baseline = (H - PAD_BOTTOM).toFixed(1);
    const buyPts = toPts(buyAsc);
    const sellPts = toPts(sellCum);
    return {
      minP,
      maxP,
      maxVol,
      buyLine: buyPts.join(" "),
      sellLine: sellPts.join(" "),
      buyArea: buyPts.length
        ? `${x(buyAsc[0].price).toFixed(1)},${baseline} ${buyPts.join(" ")} ${x(buyAsc[buyAsc.length - 1].price).toFixed(1)},${baseline}`
        : "",
      sellArea: sellPts.length
        ? `${x(sellCum[0].price).toFixed(1)},${baseline} ${sellPts.join(" ")} ${x(sellCum[sellCum.length - 1].price).toFixed(1)},${baseline}`
        : "",
    };
  }, [sell, buy]);

  if (!model) {
    return (
      <div className="rounded border border-zinc-800 p-6 text-center text-sm text-zinc-500">
        No orders to chart.
      </div>
    );
  }

  return (
    <div className="rounded border border-zinc-800 p-3">
      <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
        <span className="text-emerald-400">Buy depth</span>
        <span>Cumulative units · peak {formatInt(model.maxVol)}</span>
        <span className="text-rose-400">Sell depth</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-48 w-full"
      >
        {model.buyArea && (
          <polygon points={model.buyArea} fill="#10b98122" stroke="none" />
        )}
        {model.sellArea && (
          <polygon points={model.sellArea} fill="#fb718522" stroke="none" />
        )}
        {model.buyLine && (
          <polyline
            points={model.buyLine}
            fill="none"
            stroke="#34d399"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {model.sellLine && (
          <polyline
            points={model.sellLine}
            fill="none"
            stroke="#fb7185"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-zinc-500">
        <span>{formatIsk(model.minP)}</span>
        <span>{formatIsk(model.maxP)}</span>
      </div>
    </div>
  );
}
