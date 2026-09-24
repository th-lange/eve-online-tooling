import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  errorMessage,
  localintelSystemKills,
  type SystemKill,
} from "../../lib/api";
import { formatIsk } from "../../lib/format";

const SLOT_ORDER = ["high", "mid", "low", "rig", "subsystem", "drone"] as const;
const SLOT_LABEL: Record<string, string> = {
  high: "High",
  mid: "Mid",
  low: "Low",
  rig: "Rig",
  subsystem: "Sub",
  drone: "Drone",
};

function KillCard({
  kill,
  onAttackerClick,
}: {
  kill: SystemKill;
  onAttackerClick: (characterName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const finalBlow = kill.attackers.find((a) => a.finalBlow);

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-100">
            <span>{kill.victim.shipName}</span>
            <span className="text-zinc-600">·</span>
            <span className="truncate text-zinc-400">
              {kill.victim.characterName || "Unknown"}
            </span>
            {kill.victim.corporationName && (
              <span className="truncate text-xs text-zinc-600">
                [{kill.victim.corporationName}]
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {new Date(kill.time).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
            {kill.totalValue > 0 && (
              <>
                {" · "}
                <span className="text-amber-400">
                  {formatIsk(kill.totalValue)}
                </span>
              </>
            )}
          </div>
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          {open ? "Hide fit" : "Show fit"}
        </button>
      </div>

      {/* Victim fit (expandable) */}
      {open && kill.victim.modules.length > 0 && (
        <div className="mt-2 flex flex-col gap-0.5 border-t border-zinc-800 pt-2">
          {SLOT_ORDER.map((slot) => {
            const mods = kill.victim.modules.filter((m) => m.slot === slot);
            if (mods.length === 0) return null;
            return (
              <div key={slot} className="flex gap-2 text-[11px]">
                <span className="w-10 shrink-0 text-zinc-600">
                  {SLOT_LABEL[slot]}
                </span>
                <span className="text-zinc-300">
                  {mods
                    .map((m) =>
                      m.quantity > 1 ? `${m.name} ×${m.quantity}` : m.name,
                    )
                    .join(", ")}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Attackers — click any to profile them in the PVP module */}
      {kill.attackers.length > 0 && (
        <div className="mt-2 border-t border-zinc-800 pt-2">
          <div className="text-[10px] uppercase tracking-wide text-zinc-600">
            {kill.attackers.length} attacker
            {kill.attackers.length !== 1 ? "s" : ""}
            {finalBlow && (
              <span className="ml-2 text-zinc-500">
                · final blow: {finalBlow.characterName || "Unknown"} (
                {finalBlow.shipName})
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {kill.attackers.map((a, i) => (
              <button
                key={i}
                onClick={() => {
                  if (a.characterName) onAttackerClick(a.characterName);
                }}
                disabled={!a.characterName}
                title={
                  a.characterName
                    ? `Profile ${a.characterName} in PVP module`
                    : a.shipName
                }
                className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                  a.finalBlow
                    ? "bg-rose-900/50 text-rose-300 hover:bg-rose-900/80"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                } ${a.characterName ? "cursor-pointer" : "cursor-default"}`}
              >
                {a.shipName}
                {a.characterName ? ` · ${a.characterName}` : ""}
              </button>
            ))}
          </div>
          <div className="mt-1 text-[9px] text-zinc-700">
            click attacker to profile in PVP module
          </div>
        </div>
      )}
    </div>
  );
}

export function KillsTab({
  systemId,
  active,
}: {
  systemId: number | null;
  active: boolean;
}) {
  const navigate = useNavigate();
  const [autoRefresh, setAutoRefresh] = useState(false);

  const kills = useQuery({
    queryKey: ["localintel", "system-kills", systemId],
    queryFn: () => localintelSystemKills(systemId!),
    enabled: systemId != null && active,
    staleTime: 30_000,
    refetchInterval: active && autoRefresh ? 30_000 : false,
  });

  const onAttackerClick = (characterName: string) => {
    navigate("/pvp", { state: { pilotName: characterName } });
  };

  if (systemId == null) {
    return (
      <div className="mt-6 text-sm text-zinc-500">
        Log in a character to see kills in your current system.
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-3">
      {/* Controls row */}
      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <button
          onClick={() => void kills.refetch()}
          disabled={kills.isFetching}
          className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800 disabled:opacity-50"
        >
          {kills.isFetching ? "Refreshing…" : "Refresh"}
        </button>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.currentTarget.checked)}
          />
          Auto-refresh every 30 s
        </label>
      </div>

      {kills.isError && (
        <div className="text-sm text-rose-400">{errorMessage(kills.error)}</div>
      )}
      {kills.data && kills.data.length === 0 && (
        <div className="text-sm text-zinc-500">
          No recent combat kills in this system.
        </div>
      )}
      {kills.data?.map((k) => (
        <KillCard
          key={k.killmailId}
          kill={k}
          onAttackerClick={onAttackerClick}
        />
      ))}
      {kills.data && kills.data.length > 0 && (
        <div className="text-xs text-zinc-600">
          {kills.data.length} kill{kills.data.length !== 1 ? "s" : ""}
          {autoRefresh ? " · auto-refreshes every 30 s" : ""}
        </div>
      )}
    </div>
  );
}
