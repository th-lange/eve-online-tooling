//! Read-only query layer over the SDE SQLite database.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;

use super::types::{TypeDetail, TypeInfo, TypeNameMap};
use super::SdeError;

mod dogma;
mod industry;
mod map;
mod market;
mod pi;
mod wormholes;

pub use wormholes::wormhole_class_label;

/// A read-only handle to the SDE database. Opening is cheap, so callers may
/// open one per request; this also means an SDE update (which swaps the file)
/// is picked up on the next open.
pub struct Sde {
    conn: Connection,
}

impl Sde {
    /// Open the SDE database read-only.
    pub fn open(db_path: &Path) -> Result<Self, SdeError> {
        if !db_path.exists() {
            return Err(SdeError::NotInstalled);
        }
        let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Ok(Self { conn })
    }

    /// Type name + group + volume for a type id, if it exists.
    pub fn type_info(&self, type_id: i64) -> Result<Option<TypeInfo>, SdeError> {
        let info = self
            .conn
            .query_row(
                "SELECT t.typeID, t.typeName, t.groupID, g.groupName, t.volume
                 FROM invTypes t
                 LEFT JOIN invGroups g ON g.groupID = t.groupID
                 WHERE t.typeID = ?1",
                params![type_id],
                |row| {
                    Ok(TypeInfo {
                        type_id: row.get(0)?,
                        name: row.get(1)?,
                        group_id: row.get(2)?,
                        group_name: row.get(3)?,
                        volume: row.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(info)
    }

    /// A type's display name, or `Type <id>` if it's unknown. For the many
    /// call sites that just need a one-off name lookup with a safe fallback.
    pub fn type_name_or_id(&self, id: i64) -> String {
        self.type_info(id)
            .ok()
            .flatten()
            .map(|t| t.name)
            .unwrap_or_else(|| format!("Type {id}"))
    }

    /// Map of typeID -> meta group name (Tech II, Faction, Officer, …) for every
    /// type that has a meta entry. Types absent from the map are Tech I.
    pub fn meta_group_names(&self) -> Result<HashMap<i64, String>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT mt.typeID, mg.metaGroupName
             FROM invMetaTypes mt
             JOIN invMetaGroups mg ON mg.metaGroupID = mt.metaGroupID",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (type_id, name) = row?;
            map.insert(type_id, name);
        }
        Ok(map)
    }

    /// Search marketable types by name, capped. Each whitespace-separated term
    /// must appear (case-insensitive substring), in any order — so "shield hard"
    /// and "hard shield" both find "Large Shield Hardener". Shorter names rank
    /// first; callers can further fuzzy-rank the result. For pickers.
    pub fn search_types(&self, query: &str, limit: i64) -> Result<Vec<(i64, String)>, SdeError> {
        use rusqlite::types::Value;
        let terms: Vec<String> = query.split_whitespace().map(|t| format!("%{t}%")).collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let clause = vec!["typeName LIKE ?"; terms.len()].join(" AND ");
        let sql = format!(
            "SELECT typeID, typeName FROM invTypes
             WHERE published = 1 AND marketGroupID IS NOT NULL AND {clause}
             ORDER BY LENGTH(typeName), typeName LIMIT ?"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let mut binds: Vec<Value> = terms.into_iter().map(Value::Text).collect();
        binds.push(Value::Integer(limit));
        let rows = stmt.query_map(rusqlite::params_from_iter(binds), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Names for the given type ids (bulk), as `(type_id, name)`. For showing
    /// fitted-item names instead of ids.
    pub fn type_names(&self, type_ids: &[i64]) -> Result<Vec<(i64, String)>, SdeError> {
        if type_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; type_ids.len()].join(", ");
        let sql = format!("SELECT typeID, typeName FROM invTypes WHERE typeID IN ({placeholders})");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(type_ids.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Bulk name resolution for the given type ids in ONE query, wrapped in a
    /// map that falls back to `Type <id>` for unknown ids. For the N+1 sites
    /// that resolve names in a row-mapping loop — collect every id needed
    /// first, then call this once before mapping rows.
    pub fn type_name_map(&self, ids: &[i64]) -> Result<TypeNameMap, SdeError> {
        Ok(TypeNameMap(self.type_names(ids)?.into_iter().collect()))
    }

    /// `(type_id, name, group_name)` for the given type ids (bulk) — for grouping
    /// fits by their hull's ship group.
    pub fn type_infos(&self, type_ids: &[i64]) -> Result<Vec<(i64, String, String)>, SdeError> {
        if type_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; type_ids.len()].join(", ");
        let sql = format!(
            "SELECT t.typeID, t.typeName, COALESCE(g.groupName, '')
             FROM invTypes t LEFT JOIN invGroups g ON g.groupID = t.groupID
             WHERE t.typeID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(type_ids.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The category id for a type (Ship 6, Module 7, Charge 8, Drone 18, …), or
    /// `None` if the type is unknown. The EFT importer uses it to tell drones
    /// from cargo among the trailing `xN` lines (#162).
    pub fn type_category(&self, type_id: i64) -> Result<Option<i64>, SdeError> {
        self.conn
            .query_row(
                "SELECT g.categoryID FROM invTypes t
                 JOIN invGroups g ON g.groupID = t.groupID
                 WHERE t.typeID = ?1",
                params![type_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Resolve an item by (case-insensitive) name → `(type_id, packaged_volume)`.
    /// For the appraisal tool's clipboard parsing.
    pub fn type_by_name(&self, name: &str) -> Result<Option<(i64, Option<f64>)>, SdeError> {
        self.conn
            .query_row(
                "SELECT typeID, groupID, volume FROM invTypes
                 WHERE LOWER(typeName) = LOWER(?1) LIMIT 1",
                params![name],
                |row| {
                    let type_id: i64 = row.get(0)?;
                    let group_id: i64 = row.get(1)?;
                    let assembled: Option<f64> = row.get(2)?;
                    Ok((type_id, packaged_volume(group_id, assembled)))
                },
            )
            .optional()
            .map_err(Into::into)
    }

    /// All item categories (id, name) — the root of the universe browser tree.
    pub fn universe_categories(&self) -> Result<Vec<(i64, String)>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT categoryID, categoryName FROM invCategories ORDER BY categoryName")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Groups in a category (id, name), optionally published-only.
    pub fn universe_groups(
        &self,
        category_id: i64,
        published_only: bool,
    ) -> Result<Vec<(i64, String)>, SdeError> {
        let sql = if published_only {
            "SELECT g.groupID, g.groupName FROM invGroups g
             WHERE g.categoryID = ?1 AND EXISTS
               (SELECT 1 FROM invTypes t WHERE t.groupID = g.groupID AND t.published = 1)
             ORDER BY g.groupName"
        } else {
            "SELECT groupID, groupName FROM invGroups WHERE categoryID = ?1 ORDER BY groupName"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params![category_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Types in a group (id, name), optionally published-only.
    pub fn universe_types(
        &self,
        group_id: i64,
        published_only: bool,
    ) -> Result<Vec<(i64, String)>, SdeError> {
        let sql = if published_only {
            "SELECT typeID, typeName FROM invTypes WHERE groupID = ?1 AND published = 1 ORDER BY typeName"
        } else {
            "SELECT typeID, typeName FROM invTypes WHERE groupID = ?1 ORDER BY typeName"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params![group_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Full SDE metadata for a type (for the detail pane).
    pub fn type_detail(&self, type_id: i64) -> Result<Option<TypeDetail>, SdeError> {
        self.conn
            .query_row(
                "SELECT typeName, description, mass, volume, capacity, portionSize,
                        marketGroupID, published, basePrice
                 FROM invTypes WHERE typeID = ?1",
                params![type_id],
                |r| {
                    Ok(TypeDetail {
                        type_id,
                        name: r.get(0)?,
                        description: r.get(1)?,
                        mass: r.get(2)?,
                        volume: r.get(3)?,
                        capacity: r.get(4)?,
                        portion_size: r.get(5)?,
                        market_group_id: r.get(6)?,
                        published: r.get::<_, i64>(7).unwrap_or(0) != 0,
                        base_price: r.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    /// Map of typeID -> group name (Frigate, Cruiser, Hybrid Weapon, …).
    pub fn group_names(&self) -> Result<HashMap<i64, String>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, g.groupName
             FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (type_id, name) = row?;
            map.insert(type_id, name);
        }
        Ok(map)
    }

    /// Map of typeID -> category name (Ship, Module, Charge, Drone, …).
    pub fn category_names(&self) -> Result<HashMap<i64, String>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, c.categoryName
             FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             JOIN invCategories c ON c.categoryID = g.categoryID",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (type_id, name) = row?;
            map.insert(type_id, name);
        }
        Ok(map)
    }

    #[cfg(test)]
    fn from_connection(conn: Connection) -> Self {
        Self { conn }
    }
}

/// Packaged (hauling) volume for a type, given its group and assembled volume.
/// Ships repackage to a fixed per-group size; `invTypes.volume` is the assembled
/// figure, so combat-ship groups are overridden with their packaged constant.
/// Groups not listed (industrials, mining barges, capitals) and all non-ship
/// items fall back to the assembled/own volume.
fn packaged_volume(group_id: i64, assembled: Option<f64>) -> Option<f64> {
    let packaged = match group_id {
        // Frigate-class → 2,500 m³
        25 | 237 | 324 | 830 | 831 | 834 | 893 | 1022 | 1283 | 1527 => Some(2_500.0),
        31 => Some(500.0), // Shuttle
        // Destroyer-class → 5,000
        420 | 541 | 1305 | 1534 => Some(5_000.0),
        // Cruiser-class → 10,000
        26 | 358 | 832 | 833 | 894 | 906 | 963 | 1972 => Some(10_000.0),
        // Battlecruiser-class → 15,000
        419 | 540 | 1201 => Some(15_000.0),
        // Battleship-class → 50,000
        27 | 898 | 900 => Some(50_000.0),
        _ => None,
    };
    packaged.or(assembled)
}

#[cfg(test)]
/// Build an in-memory SDE from raw schema/data SQL, executed via
/// `execute_batch`. Shared across `sde::db`'s own tests and other modules'
/// (e.g. production's `resolve_input` tests) so each test only has to write
/// the table/row SQL it actually needs.
pub(crate) fn test_sde(sql: &str) -> Sde {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(sql).unwrap();
    Sde::from_connection(conn)
}

#[cfg(test)]
/// A tiny in-memory SDE: blueprint 999 builds 1x Widget (100) from
/// 40x Tritanium (200) + 10x Pyerite (300).
fn fixture() -> Sde {
    test_sde(
        "CREATE TABLE invGroups(groupID INT, categoryID INT, groupName TEXT);
             CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL);
             CREATE TABLE industryActivityProducts(typeID INT, activityID INT, productTypeID INT, quantity INT);
             CREATE TABLE industryActivityMaterials(typeID INT, activityID INT, materialTypeID INT, quantity INT);
             CREATE TABLE invMetaGroups(metaGroupID INT, metaGroupName TEXT);
             CREATE TABLE invMetaTypes(typeID INT, parentTypeID INT, metaGroupID INT);
             CREATE TABLE invCategories(categoryID INT, categoryName TEXT);
             CREATE TABLE industryActivityProbabilities(typeID INT, activityID INT, productTypeID INT, probability REAL);

             INSERT INTO invCategories VALUES (4, 'Gadgets');
             INSERT INTO invMetaGroups VALUES (2, 'Tech II'), (4, 'Faction');
             INSERT INTO invMetaTypes VALUES (100, NULL, 2);
             INSERT INTO invGroups VALUES (10, 4, 'Widgets'), (18, 4, 'Minerals');
             INSERT INTO invTypes VALUES
               (100, 10, 'Widget', 5.0),
               (200, 18, 'Tritanium', 0.01),
               (300, 18, 'Pyerite', 0.01),
               (500, 18, 'Datacore - Test', 0.1),
               (600, 18, 'Composite', 1.0),
               (998, 10, 'Widget I Blueprint', 0.01),
               (999, 10, 'Widget Blueprint', 0.01),
               (9000, 10, 'Composite Reaction Formula', 0.01);
             INSERT INTO industryActivityProducts VALUES (999, 1, 100, 1);
             INSERT INTO industryActivityMaterials VALUES (999, 1, 200, 40), (999, 1, 300, 10);
             -- Reaction: formula 9000 makes 100 Composite (600) from 50 Tritanium (200).
             INSERT INTO industryActivityProducts VALUES (9000, 11, 600, 100);
             INSERT INTO industryActivityMaterials VALUES (9000, 11, 200, 50);
             -- An invention row that must NOT leak into manufacturing queries.
             INSERT INTO industryActivityMaterials VALUES (999, 8, 5000, 2);
             -- Invention: T1 BP 998 invents T2 BP 999 (10 runs, 30%, 2 datacores).
             INSERT INTO industryActivityProducts VALUES (998, 8, 999, 10);
             INSERT INTO industryActivityProbabilities VALUES (998, 8, 999, 0.3);
             INSERT INTO industryActivityMaterials VALUES (998, 8, 500, 2);",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_matches_terms_in_any_order() {
        let sde = test_sde(
            "CREATE TABLE invTypes(typeID INT, typeName TEXT, marketGroupID INT, published INT);
             INSERT INTO invTypes VALUES
               (1, 'Large Shield Hardener', 10, 1),
               (2, 'Small Shield Booster', 10, 1),
               (3, 'Damage Control II', 10, 1),
               (4, 'Unpublished Shield Hardener', 10, 0);",
        );

        // Both terms must match, order-independent; unpublished excluded.
        let by_order = sde.search_types("shield hard", 10).unwrap();
        let by_reverse = sde.search_types("hard shield", 10).unwrap();
        assert_eq!(by_order, by_reverse);
        assert_eq!(by_order, vec![(1, "Large Shield Hardener".to_string())]);

        // A single term still works as a plain substring.
        let one = sde.search_types("shield", 10).unwrap();
        assert_eq!(one.len(), 2); // Hardener + Booster (published)
    }

    #[test]
    fn returns_type_info_with_group() {
        let sde = fixture();
        let info = sde.type_info(100).unwrap().unwrap();
        assert_eq!(info.name, "Widget");
        assert_eq!(info.group_id, 10);
        assert_eq!(info.group_name.as_deref(), Some("Widgets"));
        assert_eq!(info.volume, Some(5.0));
    }

    #[test]
    fn type_info_is_none_when_missing() {
        let sde = fixture();
        assert!(sde.type_info(424242).unwrap().is_none());
    }

    #[test]
    fn maps_category_names() {
        let sde = fixture();
        let cats = sde.category_names().unwrap();
        assert_eq!(cats.get(&100).map(String::as_str), Some("Gadgets"));
        assert_eq!(cats.get(&200).map(String::as_str), Some("Gadgets"));
    }

    #[test]
    fn maps_group_names() {
        let sde = fixture();
        let groups = sde.group_names().unwrap();
        assert_eq!(groups.get(&100).map(String::as_str), Some("Widgets"));
        assert_eq!(groups.get(&200).map(String::as_str), Some("Minerals"));
    }

    #[test]
    fn maps_meta_group_names() {
        let sde = fixture();
        let meta = sde.meta_group_names().unwrap();
        assert_eq!(meta.get(&100).map(String::as_str), Some("Tech II"));
        assert_eq!(meta.get(&200), None); // no meta entry -> Tech I (absent)
    }
}
