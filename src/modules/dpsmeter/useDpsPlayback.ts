import { useDpsPlaybackDerived } from "./useDpsPlaybackDerived";
import { useDpsPlaybackState } from "./useDpsPlaybackState";

/** All playback data/mutations behind the DPS meter page: `dpsStart` /
 *  `dpsPause` / `dpsPlayback` / `dpsResume` mutations, bucket/event buffering
 *  while hidden, pilot classification/colouring, readout rates, mining, and
 *  the scrub/region/loop lifecycle. Pure state + derived data — no rendering. */
export function useDpsPlayback() {
  const state = useDpsPlaybackState();
  const derived = useDpsPlaybackDerived({
    buckets: state.buckets,
    selectedPilot: state.selectedPilot,
    bySource: state.bySource,
    miningInterval: state.miningInterval,
  });

  return { ...state, ...derived };
}
