import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  openMarketWindow,
  sdeCategories,
  sdeGroups,
  sdeTypeAttributes,
  sdeTypeDetail,
  sdeTypes,
} from "../../lib/api";
import { formatInt, formatIsk } from "../../lib/format";
import { Page, PageHeader } from "../../components/page";
import { SdeGate } from "../../components/SdeGate";

const TITLE = "Universe browser";
const SUBTITLE =
  "Browse every item type: Category → Group → Type, with stats and dogma attributes.";

export function UniversePage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function Workbench() {
  const [publishedOnly, setPublishedOnly] = useState(true);
  const [openCat, setOpenCat] = useState<number | null>(null);
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const categories = useQuery({
    queryKey: ["uni", "cats"],
    queryFn: sdeCategories,
  });

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <label className="flex items-center gap-1 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={publishedOnly}
              onChange={(e) => setPublishedOnly(e.currentTarget.checked)}
            />
            Published only
          </label>
        }
      />

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="max-h-[70vh] overflow-auto rounded border border-zinc-800 bg-zinc-900 p-2 text-sm">
          {categories.data?.map((c) => (
            <div key={c.id}>
              <button
                onClick={() => setOpenCat(openCat === c.id ? null : c.id)}
                className="flex w-full items-center gap-1 px-1 py-0.5 text-left text-zinc-200 hover:bg-zinc-800/60"
              >
                <span className="w-3 text-zinc-500">
                  {openCat === c.id ? "▾" : "▸"}
                </span>
                {c.name}
              </button>
              {openCat === c.id && (
                <Groups
                  categoryId={c.id}
                  publishedOnly={publishedOnly}
                  openGroup={openGroup}
                  setOpenGroup={setOpenGroup}
                  selected={selected}
                  setSelected={setSelected}
                />
              )}
            </div>
          ))}
        </div>

        <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
          {selected ? (
            <Detail typeId={selected} />
          ) : (
            <div className="p-8 text-center text-sm text-zinc-500">
              Pick a type to see its details.
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}

function Groups({
  categoryId,
  publishedOnly,
  openGroup,
  setOpenGroup,
  selected,
  setSelected,
}: {
  categoryId: number;
  publishedOnly: boolean;
  openGroup: number | null;
  setOpenGroup: (g: number | null) => void;
  selected: number | null;
  setSelected: (t: number) => void;
}) {
  const groups = useQuery({
    queryKey: ["uni", "groups", categoryId, publishedOnly],
    queryFn: () => sdeGroups(categoryId, publishedOnly),
  });
  return (
    <div className="ml-3 border-l border-zinc-800 pl-2">
      {groups.data?.map((g) => (
        <div key={g.id}>
          <button
            onClick={() => setOpenGroup(openGroup === g.id ? null : g.id)}
            className="flex w-full items-center gap-1 px-1 py-0.5 text-left text-zinc-300 hover:bg-zinc-800/60"
          >
            <span className="w-3 text-zinc-500">
              {openGroup === g.id ? "▾" : "▸"}
            </span>
            {g.name}
          </button>
          {openGroup === g.id && (
            <Types
              groupId={g.id}
              publishedOnly={publishedOnly}
              selected={selected}
              setSelected={setSelected}
            />
          )}
        </div>
      ))}
      {groups.isLoading && <div className="px-1 text-xs text-zinc-600">…</div>}
    </div>
  );
}

function Types({
  groupId,
  publishedOnly,
  selected,
  setSelected,
}: {
  groupId: number;
  publishedOnly: boolean;
  selected: number | null;
  setSelected: (t: number) => void;
}) {
  const types = useQuery({
    queryKey: ["uni", "types", groupId, publishedOnly],
    queryFn: () => sdeTypes(groupId, publishedOnly),
  });
  return (
    <div className="ml-3 border-l border-zinc-800 pl-2">
      {types.data?.map((t) => (
        <button
          key={t.id}
          onClick={() => setSelected(t.id)}
          className={`block w-full px-1 py-0.5 text-left text-xs hover:bg-zinc-800/60 ${
            selected === t.id ? "text-emerald-400" : "text-zinc-400"
          }`}
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}

function Detail({ typeId }: { typeId: number }) {
  const detail = useQuery({
    queryKey: ["uni", "detail", typeId],
    queryFn: () => sdeTypeDetail(typeId),
  });
  const attrs = useQuery({
    queryKey: ["uni", "attrs", typeId],
    queryFn: () => sdeTypeAttributes(typeId),
  });
  const d = detail.data;
  if (!d) return <div className="p-4 text-sm text-zinc-500">Loading…</div>;
  return (
    <div>
      <div className="flex items-start justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">{d.name}</h2>
        <button
          onClick={() =>
            openMarketWindow(d.typeId).catch((e) =>
              alert(`Couldn't open market window: ${e}`),
            )
          }
          title="Open this item's market in the EVE client"
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Open in EVE
        </button>
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        type #{d.typeId}
        {!d.published && " · unpublished"}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <Stat
          label="Volume"
          value={d.volume != null ? `${formatInt(d.volume)} m³` : "—"}
        />
        <Stat
          label="Capacity"
          value={d.capacity ? `${formatInt(d.capacity)} m³` : "—"}
        />
        <Stat label="Mass" value={d.mass ? `${formatInt(d.mass)} kg` : "—"} />
        <Stat
          label="Portion size"
          value={d.portionSize ? formatInt(d.portionSize) : "—"}
        />
        <Stat
          label="Base price"
          value={d.basePrice ? formatIsk(d.basePrice) : "—"}
        />
      </dl>
      {d.description && (
        <p className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-zinc-400">
          {d.description.replace(/<[^>]+>/g, "")}
        </p>
      )}
      <h3 className="mt-4 text-sm font-medium text-zinc-300">Attributes</h3>
      <div className="mt-1 max-h-64 overflow-auto rounded border border-zinc-800">
        <table className="w-full text-xs">
          <tbody>
            {attrs.data?.map((a, i) => (
              <tr key={i} className="border-t border-zinc-800/60">
                <td className="px-2 py-0.5 text-zinc-400">{a.name}</td>
                <td className="px-2 py-0.5 text-right tabular-nums text-zinc-300">
                  {a.value.toLocaleString(undefined, {
                    maximumFractionDigits: 3,
                  })}
                </td>
              </tr>
            ))}
            {attrs.data?.length === 0 && (
              <tr>
                <td className="px-2 py-2 text-center text-zinc-600">
                  No attributes.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right tabular-nums text-zinc-200">{value}</dd>
    </>
  );
}
