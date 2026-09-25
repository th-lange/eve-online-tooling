import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart2, ClipboardPaste } from "lucide-react";
import { errorMessage, sdeSearchShips, type SlotKind } from "../../lib/api";
import { marketKeys } from "../../lib/queryKeys";
import { Page, PageHeader } from "../../components/page";
import { InlineError } from "../../components/InlineError";
import { Combo } from "../../components/Combo";
import { SdeGate } from "../../components/SdeGate";
import {
  ComparisonPanel,
  EnvironmentEffectSelector,
  EsiFitStatus,
  FitHeader,
  ModuleBrowser,
  ProjectedPanel,
  SlotGrid,
  TargetProfileBox,
} from "./components";
import { StatsAside } from "./StatsAside";
import { OptimizePanel } from "./OptimizePanel";
import { FitEditorProvider } from "./FitEditorContext";
import {
  useFitState,
  useFitMutations,
  useFitStats,
} from "./useFitEditorContext";
import { useFitPageMutations } from "./useFitPageMutations";
import { useAmmoLoadout } from "./useAmmoLoadout";
import { useFitLibrary } from "./useFitLibrary";

const FORGE = 10000002;

const TITLE = "Fitting";
const SUBTITLE =
  "Build a fit, validate slots and resources, price it, and optimize. Import/export EFT or DNA, export MultiBuy, or load your in-game fittings.";

/** Gate the editor on the SDE being installed (like the other SDE-backed pages). */
export function FittingPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <FitEditorProvider>
        <Workbench />
      </FitEditorProvider>
    </SdeGate>
  );
}

function Workbench() {
  const { fit, setFit, eft, setEft, skillSource, setSkillSource, importError } =
    useFitState();
  const { pickShip, importEft, listText, setListText, importList } =
    useFitMutations();
  const { nameOf } = useFitStats();
  const library = useFitLibrary();
  // When set (from clicking a free slot), the add-module browser filters to it.
  const [slotFilter, setSlotFilter] = useState<SlotKind | null>(null);
  const [comparing, setComparing] = useState(false);
  const [regionId, setRegionId] = useState(FORGE);

  const regions = useQuery(marketKeys.regions());
  const { price, del, pushEsi } = useFitPageMutations(regionId);
  const { ammoStats, loadAmmo } = useAmmoLoadout();

  // Combines the mutation's own error with the deep-link import path's
  // (the state slice's effect-driven import doesn't go through this mutation).
  const eftImportError =
    importError ??
    (importEft.isError
      ? `Import failed: ${errorMessage(importEft.error)}`
      : null);
  const listImportError = importList.isError
    ? `Import failed: ${errorMessage(importList.error)}`
    : null;

  return (
    <Page>
      <PageHeader title={TITLE} subtitle={SUBTITLE} />
      <div className="flex h-full flex-col gap-4">
        {/* Controls: Ship · Skills · Price · Import EFT · (right) Fits */}
        <div className="flex flex-wrap items-end gap-3">
          <Combo
            value={
              fit ? { id: fit.shipTypeId, name: nameOf(fit.shipTypeId) } : null
            }
            onPick={(v) => (v ? pickShip(v.id, v.name) : setFit(null))}
            search={sdeSearchShips}
            label="Ship (hull)"
            placeholder="search a hull…"
            width="w-56"
          />
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Skills
            <select
              value={skillSource}
              onChange={(e) =>
                setSkillSource(e.currentTarget.value as typeof skillSource)
              }
              className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
            >
              <option value="allFive">All V</option>
              <option value="character">Character</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Price at
            <select
              value={regionId}
              onChange={(e) => setRegionId(Number(e.currentTarget.value))}
              className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
            >
              {regions.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-start gap-2 pb-0.5">
            <div>
              <PasteImportControl
                label="Import EFT / DNA"
                title="Paste an EFT fit or a Ship DNA link/string to import — format is auto-detected"
                placeholder="paste an EFT fit or a DNA link here…"
                value={eft}
                setValue={setEft}
                onImport={() => importEft.mutate()}
                pending={importEft.isPending}
                mono
              />
              <InlineError
                message={eftImportError}
                className="mt-1 text-xs text-rose-400"
              />
            </div>
            <div>
              <PasteImportControl
                label="Paste list"
                title="Paste a loose item list (contract, multibuy, cargo/asset paste) to build a fit"
                placeholder={
                  "paste an item list — one item per line\n(contract, multibuy, cargo scan…)"
                }
                value={listText}
                setValue={setListText}
                onImport={() => importList.mutate()}
                pending={importList.isPending}
              />
              <InlineError
                message={listImportError}
                className="mt-1 text-xs text-rose-400"
              />
            </div>
          </div>

          {/* Fits picker — independent of the hull, grouped by ship group → hull → name */}
          <div className="ml-auto flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Fits ({library.allFits.length} saved + in-game)
              <select
                value=""
                onChange={(e) => {
                  const f = library.fitByKey.get(e.currentTarget.value);
                  if (f) setFit(f);
                }}
                className="w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
              >
                <option value="">load a fit…</option>
                {library.fitGroups.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.fits.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.hull} — {f.name}
                        {f.source === "in-game" ? "  (EVE)" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <EsiFitStatus
                esi={library.esiFits}
                refresh={library.refreshEsi}
              />
            </label>
            <button
              onClick={() => library.refreshEsi.mutate()}
              disabled={library.refreshEsi.isPending}
              title="Refresh in-game fittings from EVE (bypasses the cache)"
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              {library.refreshEsi.isPending ? "…" : "Refresh"}
            </button>
          </div>
        </div>

        {fit != null && (
          <div className="flex items-center justify-end">
            <button
              onClick={() => setComparing((v) => !v)}
              className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              <BarChart2 className="h-3.5 w-3.5" />
              {comparing ? "Hide comparison" : "Compare"}
            </button>
          </div>
        )}

        {comparing && (
          <ComparisonPanel
            currentFit={fit}
            nameOf={nameOf}
            onClose={() => setComparing(false)}
          />
        )}

        {fit == null ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Pick a hull, load a saved/in-game fit, or import an EFT fit to
            begin.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4">
            {/* Left: editor */}
            <section className="min-w-0 flex-1 overflow-auto">
              <FitHeader
                onPushEsi={pushEsi}
                onDelete={() => {
                  del.mutate(fit.id);
                  setFit(null);
                }}
                canDelete={
                  library.saved.data?.some((s) => s.id === fit.id) ?? false
                }
              />
              <InlineError
                message={
                  pushEsi.isError
                    ? `Couldn't save to EVE: ${errorMessage(pushEsi.error)}`
                    : null
                }
              />

              <OptimizePanel regionId={regionId} />

              <SlotGrid
                onAddToSlot={setSlotFilter}
                ammoStats={ammoStats}
                onFitAmmo={(typeId) => loadAmmo.mutate(typeId)}
              />
              <InlineError
                message={
                  loadAmmo.isError
                    ? `Couldn't load ammo: ${errorMessage(loadAmmo.error)}`
                    : null
                }
              />

              <ModuleBrowser
                slotFilter={slotFilter}
                onSlotFilter={setSlotFilter}
              />

              <ProjectedPanel />
              <EnvironmentEffectSelector />
              <TargetProfileBox />
            </section>

            {/* Right: stats */}
            <StatsAside price={price} />
          </div>
        )}
      </div>
    </Page>
  );
}

/**
 * Collapsible paste-to-import control (#710): a button that opens a small
 * textarea popover. Used for both EFT fits and loose item lists — the parse
 * happens in the caller's `onImport`. Closes on Import; errors surface via the
 * caller's InlineError.
 */
function PasteImportControl({
  label,
  title,
  placeholder,
  value,
  setValue,
  onImport,
  pending,
  mono = false,
}: {
  label: string;
  title: string;
  placeholder: string;
  value: string;
  setValue: (v: string) => void;
  onImport: () => void;
  pending: boolean;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={title}
        className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
          open
            ? "border-zinc-600 bg-zinc-800 text-zinc-200"
            : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
        }`}
      >
        <ClipboardPaste size={13} />
        {label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 w-96 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
            <textarea
              value={value}
              onChange={(e) => setValue(e.currentTarget.value)}
              placeholder={placeholder}
              autoFocus
              className={`h-32 w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 ${
                mono ? "font-mono" : ""
              }`}
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onImport();
                  setOpen(false);
                }}
                disabled={value.trim().length === 0 || pending}
                className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {pending ? "Importing…" : "Import"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
