import { useState } from "react";
import { errorMessage } from "../../lib/api";
import { Page, PageHeader, PrimaryButton } from "../../components/page";
import { AlarmPanel } from "./AlarmPanel";
import { HostileCorpsPanel } from "./HostileCorpsPanel";
import { KillsTab } from "./KillsTab";
import { NeighbourhoodPanel } from "./NeighbourhoodPanel";
import { PilotTable } from "./PilotTable";
import { Summary } from "./Summary";
import { useLocalIntelData } from "./useLocalIntelData";

export function LocalIntelPage() {
  const [tab, setTab] = useState<"pilots" | "kills">("pilots");
  const data = useLocalIntelData();

  return (
    <div className="flex h-full">
      {/* Visual fallback for a failed alarm beep (#819): the audio channel is
          the primary hostile-alert signal, so a screen flash makes sure a
          silent failure still gets noticed. */}
      {data.settings.flashAlert && (
        <div className="pointer-events-none fixed inset-0 z-50 animate-pulse bg-rose-600/25" />
      )}
      <div className="min-w-0 flex-1 overflow-auto">
        <Page>
          <PageHeader
            title="Local Intel"
            subtitle={
              tab === "pilots"
                ? "Select-all in the in-game Local member list, copy, and paste it here to classify every pilot by corp/alliance against your character's contacts (blue/red) and standings."
                : "Recent kills in your current system, from zKillboard."
            }
            actions={
              tab === "pilots" ? (
                <PrimaryButton
                  onClick={() => data.scan.mutate(data.text)}
                  disabled={data.scan.isPending || data.text.trim() === ""}
                  pending={data.scan.isPending}
                  pendingLabel="Scanning…"
                >
                  Scan local
                </PrimaryButton>
              ) : null
            }
          />

          {/* Tab strip */}
          <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
            {(["pilots", "kills"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded px-3 py-1.5 text-sm capitalize ${
                  tab === t
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {t === "kills" ? "System Kills" : "Pilots"}
              </button>
            ))}
          </div>

          {tab === "pilots" ? (
            <>
              <textarea
                value={data.text}
                onChange={(e) => data.setText(e.currentTarget.value)}
                placeholder="Paste the Local member list (one pilot name per line)…"
                rows={5}
                className="mt-4 w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
              />

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <input
                  value={data.logsDir}
                  onChange={(e) => data.setLogsDir(e.currentTarget.value)}
                  placeholder="EVE Chatlogs folder…"
                  className="w-72 rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none placeholder:text-zinc-600"
                  title="e.g. …/ProtonPrefix/drive_c/users/steamuser/Documents/EVE/logs/Chatlogs"
                />
                <button
                  onClick={() => data.loadLog.mutate()}
                  disabled={
                    data.logsDir.trim() === "" || data.loadLog.isPending
                  }
                  className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Load from latest Local log
                </button>
                {data.loadLog.isError && (
                  <span className="text-rose-400">
                    {errorMessage(data.loadLog.error)}
                  </span>
                )}
                {data.loadLog.data && (
                  <span className="text-zinc-500">
                    {data.loadLog.data.senders.length > 0
                      ? `${data.loadLog.data.senders.length} speaker(s) from ${data.loadLog.data.file}`
                      : "no chat found (only pilots who spoke are logged)"}
                  </span>
                )}
              </div>

              <AlarmPanel
                alertAnyRed={data.settings.alertAnyRed}
                onAlertAnyRedChange={data.setAlertAnyRed}
                alertNeutrals={data.settings.alertNeutrals}
                onAlertNeutralsChange={data.setAlertNeutrals}
                soundOn={data.settings.soundOn}
                onSoundOnChange={data.setSoundOn}
                audioUnavailable={data.settings.audioUnavailable}
                watchlist={data.watchlist.data ?? []}
                onUnwatch={data.onUnwatch}
              />

              {data.scan.isError && (
                <div className="mt-3 text-sm text-rose-400">
                  Failed: {errorMessage(data.scan.error)}
                </div>
              )}
              {data.result && <Summary result={data.result} />}
              {data.result && (
                <PilotTable
                  pilots={data.result.pilots}
                  zkill={data.zkill}
                  zkillLoading={data.zkillRun.isPending}
                  isWatched={data.isWatched}
                  newIds={data.newIds}
                  onWatch={data.onWatch}
                />
              )}
              {data.result && data.result.unresolved.length > 0 && (
                <div className="mt-2 text-xs text-zinc-500">
                  Unresolved ({data.result.unresolved.length}):{" "}
                  {data.result.unresolved.join(", ")}
                </div>
              )}
            </>
          ) : (
            <KillsTab
              systemId={data.here?.systemId ?? null}
              active={data.active}
            />
          )}
        </Page>
      </div>
      <aside className="flex w-64 shrink-0 flex-col overflow-auto border-l border-zinc-800 bg-zinc-900/40">
        <HostileCorpsPanel
          corps={data.hostileCorps}
          scanned={!!data.result}
          watchIds={data.watchIds}
          onWatch={data.onWatch}
        />
        <NeighbourhoodPanel
          here={data.here}
          nodes={data.hoodNodes}
          depth={data.hoodDepth}
          onDepth={data.setHoodDepth}
          loading={data.neighbourhoodLoading}
          locError={data.locationError}
          onRefresh={data.refreshNeighbourhood}
        />
      </aside>
    </div>
  );
}
