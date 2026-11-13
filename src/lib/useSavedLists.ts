import { type Dispatch, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  errorMessage,
  getList,
  setList as setListApi,
  type ListModule,
  type ListName,
} from "./api/common";
import { savedListKeys } from "./queryKeys";

/**
 * Favorites/blacklist state for a module's saved lists (trading, daytrading,
 * reprocessing, production — all backed by the same Rust `<module>_get_list`
 * / `<module>_set_list` commands). Queries are keyed `[module, listName]`;
 * the mutation invalidates the affected list on success.
 */
export function useSavedLists(module: ListModule) {
  const qc = useQueryClient();

  const favorites = useQuery({
    queryKey: savedListKeys.favorites(module),
    queryFn: () => getList(module, "favorites"),
  });
  const blacklist = useQuery({
    queryKey: savedListKeys.blacklist(module),
    queryFn: () => getList(module, "blacklist"),
  });

  const setList = useMutation({
    mutationFn: (v: { list: ListName; typeId: number; add: boolean }) =>
      setListApi(module, v.list, v.typeId, v.add),
    onSuccess: (_d, v) =>
      qc.invalidateQueries({ queryKey: savedListKeys.forList(module, v.list) }),
  });

  return { favorites, blacklist, setList };
}

/**
 * Favorites/blacklist state + row mutations shared by the trading/daytrading/
 * reprocessing/production workbenches: fetches both saved lists for `module`
 * and wires optimistic favorite/blacklist toggles against the local rows via
 * `setRows`. `getId` picks the id a row is keyed by (`typeId` for most
 * modules; production keys by `blueprintTypeId`).
 */
export function useTypeIdLists<T extends { favorite: boolean }>(
  module: ListModule,
  setRows: Dispatch<SetStateAction<T[]>>,
  getId: (r: T) => number,
) {
  const { favorites, blacklist, setList } = useSavedLists(module);

  // The optimistic row edits below are rolled back when the backend rejects
  // the write; otherwise a failed favorite/blacklist would look successful
  // until the next scan resurrected the row. The failure is surfaced via
  // `listError` (the mutation error clears on the next attempt).
  function toggleFavorite(r: T) {
    const id = getId(r);
    setList.mutate(
      { list: "favorites", typeId: id, add: !r.favorite },
      {
        onError: () =>
          setRows((prev) =>
            prev.map((x) =>
              getId(x) === id ? { ...x, favorite: r.favorite } : x,
            ),
          ),
      },
    );
    setRows((prev) =>
      prev.map((x) => (getId(x) === id ? { ...x, favorite: !x.favorite } : x)),
    );
  }

  function blacklistRow(r: T) {
    const id = getId(r);
    setList.mutate(
      { list: "blacklist", typeId: id, add: true },
      {
        onError: () =>
          setRows((prev) =>
            prev.some((x) => getId(x) === id) ? prev : [...prev, r],
          ),
      },
    );
    setRows((prev) => prev.filter((x) => getId(x) !== id));
  }

  function remove(list: ListName, typeId: number) {
    setList.mutate({ list, typeId, add: false });
  }

  return {
    favorites,
    blacklist,
    setList,
    /** Message of the last failed list write, or null. */
    listError: setList.isError ? errorMessage(setList.error) : null,
    toggleFavorite,
    blacklistRow,
    remove,
  };
}
