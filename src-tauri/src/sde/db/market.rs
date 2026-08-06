use rusqlite::params;
#[cfg(test)]
use rusqlite::Connection;

use super::super::types::MarketItem;
use super::super::SdeError;
use super::{packaged_volume, Sde};

impl Sde {
    /// All published items that appear on the market (for trading modules). The
    /// `volume` is the **packaged** (hauling) volume: for ships `invTypes.volume`
    /// is the *assembled* volume, so it's overridden by the per-group packaged
    /// constant (e.g. an Assault Frigate is 2,500 m³, not its ~16k assembled).
    pub fn market_items(&self) -> Result<Vec<MarketItem>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT typeID, typeName, groupID, volume FROM invTypes
             WHERE published = 1 AND marketGroupID IS NOT NULL
             ORDER BY typeID",
        )?;
        let rows = stmt.query_map([], |row| {
            let group_id: i64 = row.get(2)?;
            let assembled: Option<f64> = row.get(3)?;
            Ok(MarketItem {
                type_id: row.get(0)?,
                name: row.get(1)?,
                volume: packaged_volume(group_id, assembled),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Marketable items restricted to the given category ids (e.g. 6 = Ship,
    /// 7 = Module, 8 = Charge). An empty list means "no restriction" and falls
    /// back to the full [`market_items`](Self::market_items) catalogue. Narrowing
    /// to a few categories is the whole point of the daytrading whitelist (#87):
    /// far fewer type ids → far less market data pulled per hub.
    pub fn market_items_in_categories(
        &self,
        category_ids: &[i64],
    ) -> Result<Vec<MarketItem>, SdeError> {
        if category_ids.is_empty() {
            return self.market_items();
        }
        // Build a `(?, ?, …)` placeholder list — rusqlite has no native array bind.
        let placeholders = vec!["?"; category_ids.len()].join(", ");
        let sql = format!(
            "SELECT t.typeID, t.typeName, t.groupID, t.volume FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             WHERE t.published = 1 AND t.marketGroupID IS NOT NULL
               AND g.categoryID IN ({placeholders})
             ORDER BY t.typeID",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params = rusqlite::params_from_iter(category_ids.iter());
        let rows = stmt.query_map(params, |row| {
            let group_id: i64 = row.get(2)?;
            let assembled: Option<f64> = row.get(3)?;
            Ok(MarketItem {
                type_id: row.get(0)?,
                name: row.get(1)?,
                volume: packaged_volume(group_id, assembled),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Categories that contain at least one marketable item, for the daytrading
    /// category selector. Sorted by name.
    pub fn market_categories(&self) -> Result<Vec<(i64, String)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT c.categoryID, c.categoryName
             FROM invCategories c
             JOIN invGroups g ON g.categoryID = c.categoryID
             JOIN invTypes t ON t.groupID = g.groupID
             WHERE t.published = 1 AND t.marketGroupID IS NOT NULL
             ORDER BY c.categoryName",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// One level of EVE's market-group tree under `parent` (or the top level when
    /// `None`). Returns `(child groups, leaf items)`:
    /// - groups: `(marketGroupID, name, has_types)`, sorted by name, with empty
    ///   branches pruned (a group is kept only if it has child groups or at least
    ///   one published type beneath it).
    /// - items: `(typeID, name, metaGroupName)` published directly in `parent`,
    ///   ordered by meta group then name (so T1 → T2 → Faction reads top-down).
    ///
    /// This drives the fitting browse-by-category picker (#266): each drill-down
    /// step calls this with the chosen group id and lazy-loads the next level.
    #[allow(clippy::type_complexity)]
    pub fn market_group_children(
        &self,
        parent: Option<i64>,
    ) -> Result<(Vec<(i64, String, bool)>, Vec<(i64, String, String)>), SdeError> {
        // Child groups. The parent filter differs for the NULL (top-level) case,
        // and we prune groups with neither children nor any published type.
        let where_parent = match parent {
            Some(_) => "g.parentGroupID = ?1",
            None => "g.parentGroupID IS NULL",
        };
        let sql = format!(
            "SELECT g.marketGroupID, g.marketGroupName, COALESCE(g.hasTypes, 0)
             FROM invMarketGroups g
             WHERE {where_parent}
               AND (
                 EXISTS (SELECT 1 FROM invMarketGroups c WHERE c.parentGroupID = g.marketGroupID)
                 OR EXISTS (SELECT 1 FROM invTypes t
                            WHERE t.marketGroupID = g.marketGroupID AND t.published = 1)
               )
             ORDER BY g.marketGroupName"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let map_group = |r: &rusqlite::Row| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)? != 0,
            ))
        };
        let groups: Vec<(i64, String, bool)> = match parent {
            Some(id) => stmt
                .query_map(params![id], map_group)?
                .collect::<Result<_, _>>()?,
            None => stmt.query_map([], map_group)?.collect::<Result<_, _>>()?,
        };

        // Leaf items live directly in a group (top level has none).
        let items = match parent {
            None => Vec::new(),
            Some(id) => {
                let mut s = self.conn.prepare(
                    "SELECT t.typeID, t.typeName, COALESCE(mg.metaGroupName, 'Tech I')
                     FROM invTypes t
                     LEFT JOIN invMetaTypes mt ON mt.typeID = t.typeID
                     LEFT JOIN invMetaGroups mg ON mg.metaGroupID = mt.metaGroupID
                     WHERE t.marketGroupID = ?1 AND t.published = 1
                     ORDER BY COALESCE(mt.metaGroupID, 1), t.typeName",
                )?;
                let rows: Vec<(i64, String, String)> = s
                    .query_map(params![id], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<Result<_, _>>()?;
                rows
            }
        };
        Ok((groups, items))
    }

    /// Every known-space market region `(id, name)`, sorted by name. Region ids
    /// below 11000000 are k-space (wormhole/abyssal regions start at 11000000
    /// and have no public market); a handful of these (Jove space, dev regions)
    /// trade nothing, but ESI simply returns no orders for them. One exception:
    /// 19000001 is the Global PLEX Market CCP introduced 2026-07-07 — PLEX no
    /// longer trades in any regular region (ESI returns empty for e.g. The
    /// Forge), only here, so it's explicitly let through the id cutoff and
    /// given its display name (the SDE only carries the internal "GPMR-01").
    pub fn market_regions(&self) -> Result<Vec<(i64, String)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT regionID, regionName FROM mapRegions
             WHERE regionID < 11000000 OR regionID = 19000001
             ORDER BY regionName",
        )?;
        let rows = stmt.query_map([], |r| {
            let id: i64 = r.get(0)?;
            let name: String = r.get(1)?;
            Ok((
                id,
                if id == 19000001 {
                    "Global PLEX Market".to_string()
                } else {
                    name
                },
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_volume_overrides_ships_only() {
        // Assault Frigate (324) packages to 2,500 regardless of assembled volume.
        assert_eq!(packaged_volume(324, Some(16_500.0)), Some(2_500.0));
        assert_eq!(packaged_volume(27, Some(486_000.0)), Some(50_000.0)); // Battleship
                                                                          // Non-ship / unmapped groups keep their own volume.
        assert_eq!(packaged_volume(18, Some(0.01)), Some(0.01)); // Mineral
        assert_eq!(packaged_volume(513, Some(16_250_000.0)), Some(16_250_000.0));
        // Freighter (fallback)
    }

    #[test]
    fn market_regions_includes_kspace_and_the_global_plex_market_but_not_wormholes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE mapRegions(regionID INT, regionName TEXT);
             INSERT INTO mapRegions VALUES
               (10000002, 'The Forge'),
               (11000001, 'A-R00001'),
               (19000001, 'GPMR-01');",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

        let regions = sde.market_regions().unwrap();
        assert_eq!(
            regions,
            vec![
                (19000001, "Global PLEX Market".to_string()),
                (10000002, "The Forge".to_string()),
            ]
        );
    }

    #[test]
    fn walks_market_group_tree() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invMarketGroups(marketGroupID INT, parentGroupID INT, marketGroupName TEXT, hasTypes INT);
             CREATE TABLE invTypes(typeID INT, typeName TEXT, marketGroupID INT, published INT);
             CREATE TABLE invMetaGroups(metaGroupID INT, metaGroupName TEXT);
             CREATE TABLE invMetaTypes(typeID INT, parentTypeID INT, metaGroupID INT);

             INSERT INTO invMetaGroups VALUES (2, 'Tech II'), (4, 'Faction');
             -- top-level 'Ship Equipment' → child 'Shield Hardeners' (hasTypes) +
             -- 'Empty Branch' (no children, no published types → pruned).
             INSERT INTO invMarketGroups VALUES
               (9, NULL, 'Ship Equipment', 0),
               (40, 9, 'Shield Hardeners', 1),
               (41, 9, 'Empty Branch', 1);
             INSERT INTO invTypes VALUES
               (100, 'Multispectrum Shield Hardener I', 40, 1),
               (101, 'Multispectrum Shield Hardener II', 40, 1),
               (102, 'Gistii A-Type Hardener', 40, 1),
               (103, 'Unpublished Hardener', 40, 0);
             INSERT INTO invMetaTypes VALUES (101, 100, 2), (102, 100, 4);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

        // Top level: only 'Ship Equipment' (it has a non-empty child).
        let (groups, items) = sde.market_group_children(None).unwrap();
        assert_eq!(groups, vec![(9, "Ship Equipment".to_string(), false)]);
        assert!(items.is_empty());

        // Under 'Ship Equipment': 'Shield Hardeners' kept, 'Empty Branch' pruned.
        let (groups, _) = sde.market_group_children(Some(9)).unwrap();
        assert_eq!(groups, vec![(40, "Shield Hardeners".to_string(), true)]);

        // Leaf items: published only, ordered T1 → T2 → Faction.
        let (_, items) = sde.market_group_children(Some(40)).unwrap();
        let names: Vec<_> = items
            .iter()
            .map(|(_, n, m)| (n.as_str(), m.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("Multispectrum Shield Hardener I", "Tech I"),
                ("Multispectrum Shield Hardener II", "Tech II"),
                ("Gistii A-Type Hardener", "Faction"),
            ]
        );
    }

    /// A tiny market fixture: Ship (cat 6), Module (cat 7), Charge (cat 8),
    /// an unpublished and a non-market type that must never appear.
    fn market_fixture() -> Sde {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invCategories(categoryID INT, categoryName TEXT);
             CREATE TABLE invGroups(groupID INT, categoryID INT, groupName TEXT);
             CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL, published INT, marketGroupID INT);

             INSERT INTO invCategories VALUES (6, 'Ship'), (7, 'Module'), (8, 'Charge'), (9, 'Blueprint');
             INSERT INTO invGroups VALUES (25, 6, 'Frigate'), (60, 7, 'Cap Booster'), (85, 8, 'Charge'), (105, 9, 'Blueprint');
             INSERT INTO invTypes VALUES
               (587, 25, 'Rifter', 27.0, 1, 100),       -- ship, on market
               (400, 60, 'Cap Recharger', 5.0, 1, 200), -- module, on market
               (200, 85, 'EMP S', 0.01, 1, 300),        -- charge, on market
               (999, 105, 'Rifter Blueprint', 0.01, 1, 400), -- blueprint, on market
               (998, 25, 'Unpublished Hull', 27.0, 0, 100),  -- unpublished
               (997, 25, 'No-Market Hull', 27.0, 1, NULL);   -- not on market",
        )
        .unwrap();
        Sde::from_connection(conn)
    }

    #[test]
    fn market_items_in_categories_filters_by_category() {
        let sde = market_fixture();
        // Ships + Modules + Charges (the daytrading default) — no blueprint.
        let items = sde.market_items_in_categories(&[6, 7, 8]).unwrap();
        let ids: Vec<i64> = items.iter().map(|i| i.type_id).collect();
        assert_eq!(ids, vec![200, 400, 587]); // ordered by type id
                                              // Ship volume override (Frigate group 25 → 2,500 packaged).
        let rifter = items.iter().find(|i| i.type_id == 587).unwrap();
        assert_eq!(rifter.volume, Some(2_500.0));

        // Just one category.
        let charges = sde.market_items_in_categories(&[8]).unwrap();
        assert_eq!(
            charges.iter().map(|i| i.type_id).collect::<Vec<_>>(),
            vec![200]
        );
    }

    #[test]
    fn market_items_empty_categories_returns_all() {
        let sde = market_fixture();
        // Empty filter = whole catalogue (published + on market), incl. blueprint.
        let all = sde.market_items_in_categories(&[]).unwrap();
        assert_eq!(
            all.iter().map(|i| i.type_id).collect::<Vec<_>>(),
            vec![200, 400, 587, 999],
        );
    }

    #[test]
    fn market_categories_lists_only_marketable() {
        let sde = market_fixture();
        let cats = sde.market_categories().unwrap();
        // Sorted by name; only categories with a published, marketable type
        // (Blueprint qualifies — the Rifter Blueprint is on the market).
        assert_eq!(
            cats,
            vec![
                (9, "Blueprint".to_string()),
                (8, "Charge".to_string()),
                (7, "Module".to_string()),
                (6, "Ship".to_string()),
            ],
        );
    }
}
