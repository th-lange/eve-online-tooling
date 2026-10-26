import { useEffect, useRef, useState } from "react";
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
  focusPlanetId,
  onFocused,
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
  /** A colony to scroll to + highlight (deep-linked from a reminder), or null. */
  focusPlanetId: number | null;
  /** Called once the focus has been applied, so the parent can clear it. */
  onFocused: () => void;
}) {
  // Scroll to + briefly highlight a colony when deep-linked from a reminder.
  const refs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [highlight, setHighlight] = useState<number | null>(null);
  useEffect(() => {
    if (focusPlanetId == null) return;
    const el = refs.current.get(focusPlanetId);
    if (!el) return; // colonies may still be loading; retry when `rows` lands
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlight(focusPlanetId);
    onFocused();
    const t = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPlanetId, rows]);

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
          <div
            key={`${c.characterId}:${c.planetId}`}
            ref={(el) => {
              if (el) refs.current.set(c.planetId, el);
              else refs.current.delete(c.planetId);
            }}
            className={
              highlight === c.planetId
                ? "rounded-lg ring-2 ring-indigo-500 ring-offset-2 ring-offset-zinc-950 transition-shadow"
                : "transition-shadow"
            }
          >
            <Colony
              colony={c}
              now={now}
              lockedSet={lockedSet}
              onToggleLock={onToggleLock}
              showCharacter={multiCharacter}
              onSaveNotes={onSaveNotes}
            />
          </div>
        ))}
      </div>
    </>
  );
}

export { ColoniesTab };
