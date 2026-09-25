import { Page, PageHeader } from "../../components/page";
import { DpsChartContainer } from "./DpsChartContainer";
import { SERIES, formatRate } from "./dpsMeterShared";
import { FightBreakdown, TackleTags } from "./FightBreakdown";
import { PrimaryExtras } from "./HitQualityIndicators";
import { LogFilePanel } from "./LogFilePanel";
import { MiningPanel } from "./MiningPanel";
import { OverviewExportPanel } from "./OverviewExportPanel";
import { PlaybackControls } from "./PlaybackControls";
import { PlaybackTimeline } from "./PlaybackTimeline";
import { useDpsPlayback } from "./useDpsPlayback";

export function DpsPage() {
  const dps = useDpsPlayback();

  return (
    <Page>
      <PageHeader
        title="DPS Meter"
        subtitle="Live combat readout from your EVE gamelog — damage, logistics and capacitor warfare as a moving average. Reads only the logs the client writes (EULA-safe)."
      />

      {/* Mode tabs */}
      <div className="mt-5 flex gap-1 border-b border-zinc-800">
        {(["live", "playback"] as const).map((m) => (
          <button
            key={m}
            onClick={() => dps.switchMode(m)}
            disabled={dps.running}
            className={`px-3 py-1.5 text-sm capitalize disabled:opacity-50 ${
              dps.mode === m
                ? "border-b-2 border-indigo-500 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <LogFilePanel
          dir={dps.dir}
          onSetDir={dps.setDir}
          mode={dps.mode}
          onDirBlur={() => {
            void dps.refreshCharacters();
            if (dps.mode === "playback") void dps.refreshLogs();
          }}
          windowSecs={dps.windowSecs}
          onSetWindow={dps.setWindow}
          logs={dps.logs}
          file={dps.file}
          onSetFile={dps.setFile}
          speed={dps.speed}
          onSetSpeed={dps.setSpeed}
          characters={dps.characters}
          character={dps.character}
          onSetCharacter={dps.setCharacter}
        />
        <PlaybackControls
          mode={dps.mode}
          running={dps.running}
          paused={dps.paused}
          dir={dps.dir}
          file={dps.file}
          looping={dps.looping}
          onSetLooping={dps.setLooping}
          onPause={() => void dps.pause()}
          onResume={() => void dps.resume()}
          onStop={() => void dps.stop()}
          onStart={() => void dps.start()}
          onPlayCurrent={dps.playCurrent}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-3">
        <OverviewExportPanel
          path={dps.overviewFile}
          onSetPath={dps.setOverviewFile}
          plan={dps.extractionPlan}
          error={dps.overviewError}
          onLoad={() => void dps.loadOverviewExport()}
        />
      </div>

      {dps.mode === "playback" && dps.summary && (
        <PlaybackTimeline
          summary={dps.summary}
          position={dps.seekPos ?? dps.latest?.at ?? null}
          region={dps.region}
          onSeek={dps.seekTo}
          onSelectRegion={dps.selectRegion}
          onClearRegion={dps.clearRegion}
        />
      )}

      {dps.error && <p className="mt-3 text-sm text-rose-400">{dps.error}</p>}

      {/* Readouts */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SERIES.map((s) => (
          <div
            key={s.key}
            className={`rounded border border-zinc-800 bg-zinc-900/40 p-3 ${
              s.primary ? "col-span-1" : ""
            }`}
          >
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: s.color }}
              />
              {s.label}
            </div>
            <div
              className={`mt-1 tabular-nums ${
                s.primary ? "text-3xl font-semibold" : "text-xl"
              }`}
              style={{ color: s.color }}
            >
              {dps.filteredLatest ? formatRate(dps.filteredLatest[s.key]) : "—"}
            </div>
            {s.key === "dpsOut" && (
              <PrimaryExtras peak={dps.peakOut} quality={dps.latest?.hitsOut} />
            )}
            {s.key === "dpsIn" && (
              <PrimaryExtras peak={dps.peakIn} quality={dps.latest?.hitsIn} />
            )}
          </div>
        ))}
      </div>

      {/* Tackle warning — you can't warp out while scrambled/pointed, so
          surface it prominently. Incoming (on you) is a red alarm; outgoing
          (you holding a target) is a calmer confirmation. */}
      {dps.tackledBy.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          <span className="font-semibold uppercase tracking-wide text-rose-300">
            Tackled
          </span>
          {dps.tackledBy.map((p) => (
            <span key={p.name} className="flex items-center gap-1">
              {p.name}
              <TackleTags scram={p.scramIn} point={p.pointIn} />
            </span>
          ))}
          <span className="text-xs text-rose-300/70">— you can't warp out</span>
        </div>
      )}
      {dps.tackling.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
          <span className="font-medium uppercase tracking-wide text-zinc-500">
            Holding
          </span>
          {dps.tackling.map((p) => (
            <span key={p.name} className="flex items-center gap-1">
              {p.name}
              <TackleTags scram={p.scramOut} point={p.pointOut} />
            </span>
          ))}
        </div>
      )}

      {/* Pilot filter — buttons appear once any combat is seen; click to
          scope the charts + primary readouts to that engagement */}
      {dps.knownPilots.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-zinc-500">Filter:</span>
          <button
            onClick={() => dps.setSelectedPilot(null)}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              dps.selectedPilot === null
                ? "bg-zinc-600 text-zinc-100"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
            }`}
          >
            All
          </button>
          {dps.knownPilots.map((name) => (
            <button
              key={name}
              onClick={() =>
                dps.setSelectedPilot(dps.selectedPilot === name ? null : name)
              }
              className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                dps.selectedPilot === name
                  ? "bg-indigo-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              }`}
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: dps.sourceColors.get(name) }}
              />
              {name}
            </button>
          ))}
        </div>
      )}

      <DpsChartContainer
        bySource={dps.bySource}
        onSetBySource={dps.setBySource}
        chartLayout={dps.chartLayout}
        onSetChartLayout={dps.setChartLayout}
        filteredTicks={dps.filteredTicks}
        outSeries={dps.outSeries}
        inSeries={dps.inSeries}
        combinedSeries={dps.combinedSeries}
      />

      {/* Mining overview — only once this session has actually mined. History
          is bucketed into 15/30 s intervals, independent of the chart buffer. */}
      {dps.miningTotal > 0 && (
        <MiningPanel
          points={dps.miningPoints}
          total={dps.miningTotal}
          rate={dps.latest?.miningM3 ?? 0}
          intervalSecs={dps.miningInterval}
          onSetInterval={dps.setMiningInterval}
        />
      )}

      <FightBreakdown
        latest={dps.latest}
        pilotRows={dps.pilotRows}
        colors={dps.sourceColors}
      />

      {!dps.running && dps.ticks.length === 0 && (
        <p className="mt-4 text-sm text-zinc-500">
          Point this at your <code>Gamelogs</code> folder and press Start. Only
          combat logged after you start is counted.
        </p>
      )}
    </Page>
  );
}
