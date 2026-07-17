import { errorMessage } from "../../lib/api";
import {
  BlueprintLibrary,
  FilterChips,
  ListView,
  PasteVerdict,
  StaleBar,
  ViewTabs,
} from "./components";
import { ProfitTable, TableSkeleton } from "./ProfitTable";
import type { WorkbenchState } from "./workbenchTypes";

export function Results({ wb }: { wb: WorkbenchState }) {
  const {
    view,
    setView,
    favorites,
    blacklist,
    owned,
    imported,
    activeFilters,
    resetAllFilters,
    pasteVerdict,
    pasteMinRoi,
    profit,
    rows,
    filtered,
    regionId,
    regions,
    stationId,
    stations,
    toggleFavorite,
    blacklistRow,
    rowsByType,
    setList,
    saveImported,
    isStale,
    dirtyCount,
    autoRecalc,
    setAutoRecalc,
    calculate,
  } = wb;

  return (
    <>
      <ViewTabs
        view={view}
        onChange={setView}
        counts={{
          favorites: favorites.data?.length ?? 0,
          blacklist: blacklist.data?.length ?? 0,
          library: (owned.data?.length ?? 0) + imported.length,
        }}
      />

      {view === "opportunities" && activeFilters.length > 0 && (
        <FilterChips filters={activeFilters} onReset={resetAllFilters} />
      )}

      {view === "opportunities" && pasteVerdict && (
        <PasteVerdict
          worth={pasteVerdict.worth}
          skip={pasteVerdict.skip}
          notBuildable={pasteVerdict.notBuildable}
          minRoiPct={pasteMinRoi * 100}
        />
      )}

      <div className="mt-3">
        {view === "opportunities" &&
          (profit.isError ? (
            <div className="text-sm text-rose-400">
              Calculation failed: {errorMessage(profit.error)}
            </div>
          ) : profit.isPending && rows.length === 0 ? (
            <TableSkeleton />
          ) : (
            <ProfitTable
              rows={filtered}
              regionId={regionId}
              regionName={regions.data?.find((r) => r.id === regionId)?.name}
              hub={
                stationId != null
                  ? stations.find((s) => s.id === stationId)?.name
                  : undefined
              }
              onFavorite={toggleFavorite}
              onBlacklist={blacklistRow}
            />
          ))}

        {view === "favorites" && (
          <ListView
            items={favorites.data ?? []}
            rowsByType={rowsByType}
            removeLabel="Unfavorite"
            emptyTitle="No favorites yet"
            emptyHint="Star a row in the Opportunities table to track it here."
            onRemove={(id) =>
              setList.mutate({ list: "favorites", typeId: id, add: false })
            }
          />
        )}
        {view === "blacklist" && (
          <ListView
            items={blacklist.data ?? []}
            rowsByType={rowsByType}
            removeLabel="Remove"
            emptyTitle="Nothing blacklisted"
            emptyHint="Hide an item with the blacklist button in Opportunities and it’ll appear here."
            onRemove={(id) =>
              setList.mutate({ list: "blacklist", typeId: id, add: false })
            }
          />
        )}
        {view === "library" && (
          <BlueprintLibrary
            owned={owned.data ?? []}
            imported={imported}
            onImport={saveImported}
          />
        )}
      </div>

      {view === "opportunities" && isStale && (
        <StaleBar
          dirtyCount={dirtyCount}
          pending={profit.isPending}
          auto={autoRecalc}
          onToggleAuto={() => setAutoRecalc((a) => !a)}
          onRecalc={calculate}
        />
      )}
    </>
  );
}
