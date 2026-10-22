import { type ColonyView } from "../../lib/api";
import { QueryErrorNotice } from "../../components/QueryErrorNotice";
import { Centered } from "../../components/page";
import { Colony } from "./Colony";

function ColoniesTab({
  colonies,
  rows,
  now,
  lockedSet,
  onToggleLock,
  multiCharacter,
  onSaveNotes,
}: {
  colonies: { error: unknown; isError: boolean; isFetching: boolean };
  rows: ColonyView[];
  now: number;
  lockedSet: Set<number>;
  onToggleLock: (typeId: number) => void;
  multiCharacter: boolean;
  onSaveNotes: (
    characterId: number,
    planetId: number,
    notes: string,
    targetProductTypeIds: number[],
  ) => void;
}) {
  return (
    <>
      <QueryErrorNotice
        error={colonies.error}
        loginMessage="Log in a character first to view your colonies."
        scopeHint={
          <>
            needs <code>esi-planets.manage_planets.v1</code> — re-login if just
            enabled
          </>
        }
        className="mt-4 text-sm"
      />

      {!colonies.isError && rows.length === 0 && !colonies.isFetching && (
        <Centered>No colonies found for this character.</Centered>
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {rows.map((c) => (
          <Colony
            key={`${c.characterId}:${c.planetId}`}
            colony={c}
            now={now}
            lockedSet={lockedSet}
            onToggleLock={onToggleLock}
            showCharacter={multiCharacter}
            onSaveNotes={onSaveNotes}
          />
        ))}
      </div>
    </>
  );
}

export { ColoniesTab };
