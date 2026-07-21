import { useMemo, useState, type MouseEvent } from "react";
import type { DepthLevel } from "../lib/api";
import { formatInt, formatIsk } from "../lib/format";

// Market-depth chart: two cumulative curves sharing a volume axis. The buy
// curve (emerald) accumulates demand from the highest bid downward; the sell
// curve (rose) accumulates supply from the lowest ask upward. They rise away
// from the spread in the middle — a steep wall means thin liquidity there.
// Hovering reads out the price under the cursor plus the buy demand at or above
// it and the sell supply at or below it.

const W = 640;
const H = 200;
const PAD_X = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

interface Cum {
  price: number;
  total: number;
}

/** Running total of `volume` across levels, paired with each level's price. */
function cumulative(levels: DepthLevel[]): Cum[] {
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
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverY, setHoverY] = useState<number | null>(null);

  const model = useMemo(() => {
    // Sell is ascending, buy descending (as the backend returns them). Buy's
    // cumulative is demand from the highest bid down; reverse to ascending price
    // for plotting so its wall rises toward the spread from the left.
    const sellCum = cumulative(sell);
    const buyAsc = [...cumulative(buy)].reverse();
    const prices = [...sell, ...buy].map((l) => l.price);
    if (prices.length === 0) return null;
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const spanP = maxP - minP || 1;
    const maxVol =
      Math.max(
        sellCum.length ? sellCum[sellCum.length - 1].total : 0,
        buyAsc.length ? buyAsc[0].total : 0,
      ) || 1;
    const x = (price: number) =>
      PAD_X + ((price - minP) / spanP) * (W - 2 * PAD_X);
    const y = (vol: number) =>
      H - PAD_BOTTOM - (vol / maxVol) * (H - PAD_TOP - PAD_BOTTOM);
    const baseline = (H - PAD_BOTTOM).toFixed(1);
    const toPts = (pts: Cum[]) =>
      pts.map((p) => `${x(p.price).toFixed(1)},${y(p.total).toFixed(1)}`);
    const buyPts = toPts(buyAsc);
    const sellPts = toPts(sellCum);
    return {
      minP,
      maxP,
      spanP,
      maxVol,
      sellCum,
      buyAsc,
      x,
      y,
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

  // Reading at the cursor: the price under it, sell supply at or below that
  // price, and buy demand at or above it.
  const reading = useMemo(() => {
    if (!model || hoverX == null) return null;
    const price = model.minP + (hoverX / (W - 2 * PAD_X)) * model.spanP;
    // Sell supply available at price ≤ cursor: cumulative up to the last sell
    // level not above it.
    let sellVol = 0;
    for (const lvl of model.sellCum) {
      if (lvl.price <= price) sellVol = lvl.total;
      else break;
    }
    // Buy demand resting at price ≥ cursor: buyAsc is ascending, its totals are
    // cumulative-from-top, so the first level at/above the cursor carries it.
    let buyVol = 0;
    for (const lvl of model.buyAsc) {
      if (lvl.price >= price) {
        buyVol = lvl.total;
        break;
      }
    }
    return { price, sellVol, buyVol, px: PAD_X + hoverX };
  }, [model, hoverX]);

  function onMove(e: MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * W - PAD_X;
    const ry = ((e.clientY - rect.top) / rect.height) * H;
    setHoverX(Math.max(0, Math.min(W - 2 * PAD_X, rx)));
    setHoverY(Math.max(PAD_TOP, Math.min(H - PAD_BOTTOM, ry)));
  }

  if (!model) {
    return (
      <div className="rounded border border-zinc-800 p-6 text-center text-sm text-zinc-500">
        No orders to chart.
      </div>
    );
  }

  return (
    <div className="rounded border border-zinc-800 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="text-emerald-400">Buy depth</span>
        <span className="ml-auto tabular-nums text-zinc-300">
          {reading
            ? `${formatIsk(reading.price)} · buy ${formatInt(reading.buyVol)} / sell ${formatInt(reading.sellVol)}`
            : `Cumulative units · peak ${formatInt(model.maxVol)}`}
        </span>
        <span className="ml-auto text-rose-400">Sell depth</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-48 w-full"
        onMouseMove={onMove}
        onMouseLeave={() => {
          setHoverX(null);
          setHoverY(null);
        }}
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
        {reading && (
          <g>
            <line
              x1={reading.px}
              x2={reading.px}
              y1={PAD_TOP}
              y2={H - PAD_BOTTOM}
              stroke="#52525b"
              strokeWidth="0.75"
            />
            {hoverY != null && (
              <line
                x1={PAD_X}
                x2={W - PAD_X}
                y1={hoverY}
                y2={hoverY}
                stroke="#52525b"
                strokeWidth="0.75"
              />
            )}
            {reading.buyVol > 0 && (
              <circle
                cx={reading.px}
                cy={model.y(reading.buyVol)}
                r="3"
                fill="#34d399"
              />
            )}
            {reading.sellVol > 0 && (
              <circle
                cx={reading.px}
                cy={model.y(reading.sellVol)}
                r="3"
                fill="#fb7185"
              />
            )}
          </g>
        )}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-zinc-500">
        <span>{formatIsk(model.minP)}</span>
        <span>{formatIsk(model.maxP)}</span>
      </div>
    </div>
  );
}
