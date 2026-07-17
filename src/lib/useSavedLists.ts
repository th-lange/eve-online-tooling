import { type Dispatch, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getList,
  setList as setListApi,
  type ListModule,
  type ListName,
} from "./api/common";

/**
 * Favorites/blacklist state for a module's saved lists (trading, daytrading,
 * reprocessing, production — all backed by the same Rust `<module>_get_list`
 * / `<module>_set_list` commands). Queries are keyed `[module, listName]`;
 * the mutation invalidates the affected list on success.
 */
export function useSavedLists(module: ListModule) {
  const qc = useQueryClient();

  const favorites = useQuery({
    queryKey: [module, "favorites"],
    queryFn: () => getList(module, "favorites"),
  });
  const blacklist = useQuery({
    queryKey: [module, "blacklist"],
    queryFn: () => getList(module, "blacklist"),
  });

  const setList = useMutation({
    mutationFn: (v: { list: ListName; typeId: number; add: boolean }) =>
      setListApi(module, v.list, v.typeId, v.add),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: [module, v.list] }),
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

  function toggleFavorite(r: T) {
    const id = getId(r);
    setList.mutate({ list: "favorites", typeId: id, add: !r.favorite });
    setRows((prev) =>
      prev.map((x) => (getId(x) === id ? { ...x, favorite: !x.favorite } : x)),
    );
  }

  function blacklistRow(r: T) {
    const id = getId(r);
    setList.mutate({ list: "blacklist", typeId: id, add: true });
    setRows((prev) => prev.filter((x) => getId(x) !== id));
  }

  function remove(list: ListName, typeId: number) {
    setList.mutate({ list, typeId, add: false });
  }

  return {
    favorites,
    blacklist,
    setList,
    toggleFavorite,
    blacklistRow,
    remove,
  };
}
