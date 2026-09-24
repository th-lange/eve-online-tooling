import { useDpsPlaybackDerived } from "./useDpsPlaybackDerived";
import { useDpsPlaybackState } from "./useDpsPlaybackState";

/** All playback data/mutations behind the DPS meter page: `dpsStart` /
 *  `dpsPause` / `dpsPlayback` / `dpsResume` mutations, tick buffering while
 *  hidden, pilot classification/colouring, mining accumulation, and the
 *  scrub/region/loop lifecycle. Pure state + derived data — no rendering. */
export function useDpsPlayback() {
  const state = useDpsPlaybackState();
  const derived = useDpsPlaybackDerived({
    ticks: state.ticks,
    latest: state.latest,
    selectedPilot: state.selectedPilot,
    bySource: state.bySource,
    miningInterval: state.miningInterval,
    miningRef: state.miningRef,
  });

  return { ...state, ...derived };
}
