import { useCallback, useEffect, useState, type SetStateAction } from "react";
import {
  errorMessage,
  fittingImportEft,
  type AbyssalWeatherSelection,
  type Fit,
  type FleetBoost,
  type SkillSource,
  type TargetProfile,
} from "../../lib/api";
import { subscribeFitImport, takePendingFitImport } from "../../lib/deepLink";
import { stackCargo } from "./fitHelpers";

export type SetFit = (value: SetStateAction<Fit | null>) => void;

/** The fit-editing state machine's raw client-side state: the current `Fit`
 *  plus every knob that feeds the simulate query (skills, jam, damage
 *  profile, target, fleet boosts, environment) but isn't itself derived from
 *  a query. No backend round-trips live here — see `useFitCoreMutations`. */
export interface FitStateSlice {
  fit: Fit | null;
  setFit: SetFit;
  eft: string;
  setEft: (v: string) => void;
  importError: string | null;
  skillSource: SkillSource;
  setSkillSource: (v: SkillSource) => void;
  skillLabel: string;
  jammed: boolean;
  setJammed: (v: boolean) => void;
  damageProfile: [number, number, number, number] | undefined;
  setDamageProfile: (p: [number, number, number, number] | undefined) => void;
  neutGjs: number | undefined;
  setNeutGjs: (n: number | undefined) => void;
  targetProfile: TargetProfile | undefined;
  setTargetProfile: (p: TargetProfile | undefined) => void;
  fleetBoosts: FleetBoost[];
  addFleetBoost: (boost: FleetBoost) => void;
  removeFleetBoost: (idx: number) => void;
  environmentEffect: number | null;
  setEnvironmentEffect: (id: number | null) => void;
  abyssalWeather: AbyssalWeatherSelection | null;
  setAbyssalWeather: (selection: AbyssalWeatherSelection | null) => void;
  spoolPct: number | undefined;
  setSpoolPct: (pct: number | undefined) => void;
}

/** Raw fit-editing state — the `FitStateSlice` half of `useFitEditor`'s old
 *  monolith. Called once by `FitEditorProvider`; consumers read it back via
 *  `useFitState()` from `useFitEditorContext`. */
export function useFitCoreState(): FitStateSlice {
  const [fit, setFitRaw] = useState<Fit | null>(null);
  // Every fit that lands in the editor is normalized so the cargo hold shows
  // one stack per item type — imports (e.g. the PVP "Simulate") can otherwise
  // land the same charge as several separate cargo lines. Idempotent, so
  // ordinary edits pass through unchanged.
  const setFit: SetFit = useCallback((value) => {
    setFitRaw((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      return next ? stackCargo(next) : next;
    });
  }, []);
  const [eft, setEft] = useState("");
  // Set when the deep-link EFT import path (the effect below) fails — the
  // mutation-backed import (`importEft`, in useFitCoreMutations) tracks its
  // own error via TanStack Query, this covers the other entry point (#820).
  const [importError, setImportError] = useState<string | null>(null);
  const [skillSource, setSkillSource] = useState<SkillSource>("allFive");
  const skillLabel = skillSource === "character" ? "character" : "all V";
  // ECM is a chance-to-jam, not a continuous effect — so it's an opt-in "what if
  // the jam lands" view (targeting disabled), never a passive stat (#265).
  const [jammed, setJammed] = useState(false);
  // Incoming damage profile + neut pressure for the simulate query — undefined
  // means "let the backend default" (even damage, no neuts).
  const [damageProfile, setDamageProfile] = useState<
    [number, number, number, number] | undefined
  >(undefined);
  const [neutGjs, setNeutGjs] = useState<number | undefined>(undefined);
  // Target profile for applied-DPS + the DPS-vs-range curve (#701); undefined
  // means "no target selected" (paper DPS only).
  const [targetProfile, setTargetProfile] = useState<TargetProfile | undefined>(
    undefined,
  );
  // Command-burst/fleet-link modules the fit is "receiving" from a fleet
  // member (#705); empty means no fleet boosts applied.
  const [fleetBoosts, setFleetBoosts] = useState<FleetBoost[]>([]);
  // Wormhole-class or Pochven metaliminal-storm environment the fit is
  // sitting in; null means no environment effect applied. Mutually
  // exclusive with `abyssalWeather` below — a fit sits in one space.
  const [environmentEffect, setEnvironmentEffectRaw] = useState<number | null>(
    null,
  );
  // Abyssal Deadspace weather the fit is sitting in — separate from
  // `environmentEffect` since it's hardcoded (no SDE type backs it), not a
  // beacon type id. Mutually exclusive with `environmentEffect`.
  const [abyssalWeather, setAbyssalWeatherRaw] =
    useState<AbyssalWeatherSelection | null>(null);
  // Triglavian/spoolable-weapon ramp fraction (#872) for the simulate query;
  // undefined means "let the backend default" (1.0, fully spooled).
  const [spoolPct, setSpoolPct] = useState<number | undefined>(undefined);
  function setEnvironmentEffect(id: number | null) {
    setEnvironmentEffectRaw(id);
    if (id != null) setAbyssalWeatherRaw(null);
  }
  function setAbyssalWeather(selection: AbyssalWeatherSelection | null) {
    setAbyssalWeatherRaw(selection);
    if (selection != null) setEnvironmentEffectRaw(null);
  }
  function addFleetBoost(boost: FleetBoost) {
    setFleetBoosts((prev) => [...prev, boost]);
  }
  function removeFleetBoost(idx: number) {
    setFleetBoosts((prev) => prev.filter((_, i) => i !== idx));
  }

  // A fit handed in from another module (e.g. the PVP tab's "Simulate") — load
  // it as soon as it arrives, or on first mount if it was stashed before this
  // page existed. Pages keep-alive in the Layout host, so we handle both, the
  // same way Market Search consumes a deep-linked item.
  useEffect(() => {
    const load = async (text: string) => {
      try {
        setImportError(null);
        setFit(await fittingImportEft(text));
      } catch (e) {
        console.error("Deep-linked EFT import failed", e);
        setImportError(`Import failed: ${errorMessage(e)}`);
      }
    };
    const stashed = takePendingFitImport();
    if (stashed) void load(stashed);
    return subscribeFitImport(load);
  }, [setFit]);

  return {
    fit,
    setFit,
    eft,
    setEft,
    importError,
    skillSource,
    setSkillSource,
    skillLabel,
    jammed,
    setJammed,
    damageProfile,
    setDamageProfile,
    neutGjs,
    setNeutGjs,
    targetProfile,
    setTargetProfile,
    fleetBoosts,
    addFleetBoost,
    removeFleetBoost,
    environmentEffect,
    setEnvironmentEffect,
    abyssalWeather,
    setAbyssalWeather,
    spoolPct,
    setSpoolPct,
  };
}
