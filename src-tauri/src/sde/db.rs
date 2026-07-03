//! Read-only query layer over the SDE SQLite database.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;

use super::types::{
    activity, AttrMeta, BlueprintMaterial, BlueprintProduct, Decryptor, EffectMeta, InventionData,
    ManufacturableBlueprint, MarketItem, ModifierInfo, PlanetSchematic, Recipe, ReprocessRecipe,
    ShipLayout, TypeDetail, TypeInfo, WormholeType,
};
use super::SdeError;

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

    /// Materials for a blueprint/formula at a given activity, with names.
    fn materials_for(
        &self,
        type_id: i64,
        activity_id: i64,
    ) -> Result<Vec<BlueprintMaterial>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT iam.materialTypeID, t.typeName, iam.quantity
             FROM industryActivityMaterials iam
             JOIN invTypes t ON t.typeID = iam.materialTypeID
             WHERE iam.typeID = ?1 AND iam.activityID = ?2
             ORDER BY iam.materialTypeID",
        )?;
        let rows = stmt.query_map(params![type_id, activity_id], |row| {
            Ok(BlueprintMaterial {
                material_type_id: row.get(0)?,
                name: row.get(1)?,
                quantity: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Manufacturing inputs (activity 1) for a blueprint, with material names.
    pub fn blueprint_materials(
        &self,
        blueprint_type_id: i64,
    ) -> Result<Vec<BlueprintMaterial>, SdeError> {
        self.materials_for(blueprint_type_id, activity::MANUFACTURING)
    }

    /// How to build a product directly: its manufacturing blueprint (preferred)
    /// or reaction formula. `None` if it isn't produced by either (e.g. a raw
    /// mineral — buy it).
    pub fn recipe_for(&self, product_type_id: i64) -> Result<Option<Recipe>, SdeError> {
        for activity_id in [activity::MANUFACTURING, activity::REACTION] {
            let row: Option<(i64, i64)> = self
                .conn
                .query_row(
                    "SELECT typeID, quantity
                     FROM industryActivityProducts
                     WHERE activityID = ?1 AND productTypeID = ?2
                     LIMIT 1",
                    params![activity_id, product_type_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((blueprint_type_id, product_quantity)) = row {
                let materials = self.materials_for(blueprint_type_id, activity_id)?;
                return Ok(Some(Recipe {
                    blueprint_type_id,
                    activity_id,
                    product_quantity,
                    materials,
                }));
            }
        }
        Ok(None)
    }

    /// What a blueprint manufactures (activity 1), if anything.
    pub fn blueprint_product(
        &self,
        blueprint_type_id: i64,
    ) -> Result<Option<BlueprintProduct>, SdeError> {
        let product = self
            .conn
            .query_row(
                "SELECT iap.productTypeID, t.typeName, iap.quantity
                 FROM industryActivityProducts iap
                 JOIN invTypes t ON t.typeID = iap.productTypeID
                 WHERE iap.typeID = ?1 AND iap.activityID = ?2
                 LIMIT 1",
                params![blueprint_type_id, activity::MANUFACTURING],
                |row| {
                    Ok(BlueprintProduct {
                        product_type_id: row.get(0)?,
                        name: row.get(1)?,
                        quantity: row.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(product)
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

    /// Every blueprint that has a manufacturing product (activity 1).
    pub fn manufacturable_blueprints(&self) -> Result<Vec<ManufacturableBlueprint>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT iap.typeID, iap.productTypeID, t.typeName, iap.quantity
             FROM industryActivityProducts iap
             JOIN invTypes t ON t.typeID = iap.productTypeID
             WHERE iap.activityID = ?1
             ORDER BY t.typeName",
        )?;
        let rows = stmt.query_map(params![activity::MANUFACTURING], |row| {
            Ok(ManufacturableBlueprint {
                blueprint_type_id: row.get(0)?,
                product_type_id: row.get(1)?,
                product_name: row.get(2)?,
                product_quantity: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The invention (activity 8) that produces this blueprint, if it's a T2
    /// blueprint invented from a T1 one. `None` for T1 (uninvented) blueprints.
    pub fn invention_for(&self, blueprint_type_id: i64) -> Result<Option<InventionData>, SdeError> {
        let inv: Option<(i64, i64)> = self
            .conn
            .query_row(
                "SELECT typeID, quantity
                 FROM industryActivityProducts
                 WHERE activityID = ?1 AND productTypeID = ?2
                 LIMIT 1",
                params![activity::INVENTION, blueprint_type_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((inventing_blueprint_type_id, runs_per_success)) = inv else {
            return Ok(None);
        };

        let probability: f64 = self
            .conn
            .query_row(
                "SELECT probability
                 FROM industryActivityProbabilities
                 WHERE activityID = ?1 AND typeID = ?2 AND productTypeID = ?3
                 LIMIT 1",
                params![
                    activity::INVENTION,
                    inventing_blueprint_type_id,
                    blueprint_type_id
                ],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0.0);

        let mut stmt = self.conn.prepare(
            "SELECT iam.materialTypeID, t.typeName, iam.quantity
             FROM industryActivityMaterials iam
             JOIN invTypes t ON t.typeID = iam.materialTypeID
             WHERE iam.typeID = ?1 AND iam.activityID = ?2
             ORDER BY iam.materialTypeID",
        )?;
        let datacores = stmt
            .query_map(
                params![inventing_blueprint_type_id, activity::INVENTION],
                |row| {
                    Ok(BlueprintMaterial {
                        material_type_id: row.get(0)?,
                        name: row.get(1)?,
                        quantity: row.get(2)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;

        // T3 (strategic cruiser / subsystem) invention consumes an Ancient Relic
        // bought at market, rather than copying a T1 blueprint. Detect that by the
        // inventing type's category so its market cost can be priced in (#12).
        let relic: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT t.typeName, c.categoryName
                 FROM invTypes t
                 JOIN invGroups g ON g.groupID = t.groupID
                 JOIN invCategories c ON c.categoryID = g.categoryID
                 WHERE t.typeID = ?1",
                params![inventing_blueprint_type_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let relic = relic
            .filter(|(_, category)| category == "Ancient Relics")
            .map(|(name, _)| BlueprintMaterial {
                material_type_id: inventing_blueprint_type_id,
                name,
                quantity: 1,
            });

        Ok(Some(InventionData {
            inventing_blueprint_type_id,
            runs_per_success,
            probability,
            datacores,
            relic,
        }))
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

    /// The invention decryptors and their modifiers (probability / ME / runs),
    /// read from `dgmTypeAttributes` (1112 / 1113 / 1124).
    pub fn decryptors(&self) -> Result<Vec<Decryptor>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, t.typeName,
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1112),
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1113),
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1124)
             FROM invTypes t
             WHERE t.typeName LIKE '%Decryptor%' AND t.published = 1
             ORDER BY t.typeName",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Decryptor {
                type_id: row.get(0)?,
                name: row.get(1)?,
                probability_multiplier: row.get::<_, Option<f64>>(2)?.unwrap_or(1.0),
                me_modifier: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0) as i64,
                run_modifier: row.get::<_, Option<f64>>(4)?.unwrap_or(0.0) as i64,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

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

    /// Charges usable in `weapon_type_id`: published types whose group is one of
    /// the weapon's `chargeGroup1..5` (attrs 604–608), whose `chargeSize` (128)
    /// matches when the weapon is sized, and that physically fit its ammo capacity
    /// (charge volume ≤ module capacity). Ordered Tech I → II → Faction then name.
    /// Empty when the module takes no charge. Drives the per-weapon ammo picker.
    pub fn compatible_charges(&self, weapon_type_id: i64) -> Result<Vec<(i64, String)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, t.typeName
             FROM invTypes t
             WHERE t.published = 1
               AND t.groupID IN (
                 SELECT CAST(valueFloat AS INTEGER) FROM dgmTypeAttributes
                 WHERE typeID = ?1 AND attributeID IN (604, 605, 606, 607, 608)
                   AND valueFloat IS NOT NULL
               )
               -- Fits the ammo capacity (skip when the module records none).
               AND t.volume <= COALESCE(
                 NULLIF((SELECT capacity FROM invTypes WHERE typeID = ?1), 0), 1e30)
               -- Size must match when the weapon is sized (turrets/launchers);
               -- script-takers (no chargeSize) accept any size in the group.
               AND (
                 (SELECT valueFloat FROM dgmTypeAttributes
                  WHERE typeID = ?1 AND attributeID = 128) IS NULL
                 OR (SELECT valueFloat FROM dgmTypeAttributes
                     WHERE typeID = t.typeID AND attributeID = 128)
                    = (SELECT valueFloat FROM dgmTypeAttributes
                       WHERE typeID = ?1 AND attributeID = 128)
               )
             ORDER BY
               COALESCE((SELECT metaGroupID FROM invMetaTypes WHERE typeID = t.typeID), 1),
               t.typeName",
        )?;
        let rows = stmt.query_map(params![weapon_type_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
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

    /// Search published **ships** (category 6) by name substring, capped. For the
    /// fitting hull picker (so it doesn't offer modules/charges/blueprints).
    pub fn search_ships(&self, query: &str, limit: i64) -> Result<Vec<(i64, String)>, SdeError> {
        let pattern = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, t.typeName FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             WHERE g.categoryID = 6 AND t.published = 1 AND t.typeName LIKE ?1
             ORDER BY LENGTH(t.typeName), t.typeName LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
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

    /// The reprocessing recipe for a single type (any item with refine outputs),
    /// or `None`. For the reprocess-appraisal tool.
    pub fn reprocess_recipe(&self, type_id: i64) -> Result<Option<ReprocessRecipe>, SdeError> {
        let portion: Option<i64> = self
            .conn
            .query_row(
                "SELECT portionSize FROM invTypes WHERE typeID = ?1 AND portionSize > 0",
                params![type_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(portion_size) = portion else {
            return Ok(None);
        };
        let name = self
            .type_info(type_id)?
            .map(|t| t.name)
            .unwrap_or_else(|| format!("Type {type_id}"));
        let mut stmt = self.conn.prepare(
            "SELECT m.materialTypeID, t.typeName, m.quantity
             FROM invTypeMaterials m JOIN invTypes t ON t.typeID = m.materialTypeID
             WHERE m.typeID = ?1 ORDER BY m.materialTypeID",
        )?;
        let outputs = stmt
            .query_map(params![type_id], |r| {
                Ok(BlueprintMaterial {
                    material_type_id: r.get(0)?,
                    name: r.get(1)?,
                    quantity: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if outputs.is_empty() {
            return Ok(None);
        }
        Ok(Some(ReprocessRecipe {
            type_id,
            name,
            portion_size,
            outputs,
        }))
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

    /// Published, reprocessable items in a category (e.g. 25 = Asteroid/ore),
    /// each with its `portionSize` and per-portion refine outputs from
    /// `invTypeMaterials`. One query, grouped in Rust.
    pub fn reprocess_recipes(&self, category_id: i64) -> Result<Vec<ReprocessRecipe>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, t.typeName, t.portionSize, m.materialTypeID, mt.typeName, m.quantity
             FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             JOIN invTypeMaterials m ON m.typeID = t.typeID
             JOIN invTypes mt ON mt.typeID = m.materialTypeID
             WHERE g.categoryID = ?1 AND t.published = 1 AND t.portionSize > 0
             ORDER BY t.typeID, m.materialTypeID",
        )?;
        let rows = stmt.query_map(params![category_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,    // type id
                row.get::<_, String>(1)?, // type name
                row.get::<_, i64>(2)?,    // portion size
                BlueprintMaterial {
                    material_type_id: row.get(3)?,
                    name: row.get(4)?,
                    quantity: row.get(5)?,
                },
            ))
        })?;

        // Group consecutive rows (ordered by type id) into one recipe per item.
        let mut out: Vec<ReprocessRecipe> = Vec::new();
        for row in rows {
            let (type_id, name, portion_size, material) = row?;
            match out.last_mut() {
                Some(r) if r.type_id == type_id => r.outputs.push(material),
                _ => out.push(ReprocessRecipe {
                    type_id,
                    name,
                    portion_size,
                    outputs: vec![material],
                }),
            }
        }
        Ok(out)
    }

    /// Map of blueprint type id -> base activity time (seconds) for `activity_id`
    /// (1 = manufacturing), from `industryActivity`. Used for job-time estimates.
    pub fn base_times(&self, activity_id: i64) -> Result<HashMap<i64, i64>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT typeID, time FROM industryActivity WHERE activityID = ?1")?;
        let rows = stmt.query_map(params![activity_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>()
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

    /// Dogma attributes for a type: (display name, value), published attrs only.
    pub fn type_attributes(&self, type_id: i64) -> Result<Vec<(String, f64)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT COALESCE(NULLIF(a.displayName, ''), a.attributeName),
                    COALESCE(ta.valueFloat, ta.valueInt)
             FROM dgmTypeAttributes ta
             JOIN dgmAttributeTypes a ON a.attributeID = ta.attributeID
             WHERE ta.typeID = ?1 AND a.published = 1
             ORDER BY a.attributeName",
        )?;
        let rows = stmt.query_map(params![type_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// All dogma attributes for a type as `(attributeID, value)`. Unlike
    /// [`type_attributes`](Self::type_attributes) this keys by id and keeps
    /// unpublished attributes, because the fitting engine reads by id (#158).
    pub fn type_attributes_raw(&self, type_id: i64) -> Result<Vec<(i64, f64)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT attributeID, COALESCE(valueFloat, valueInt)
             FROM dgmTypeAttributes WHERE typeID = ?1",
        )?;
        let rows = stmt.query_map(params![type_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Batched [`type_attributes_raw`](Self::type_attributes_raw): one query for
    /// many types (a whole fit + its skills), grouped by typeID in Rust. Avoids
    /// the per-item round-trips that resolving a full fit would otherwise need.
    #[allow(dead_code)] // consumed by the dogma engine (P2, #171)
    pub fn types_attributes_raw(
        &self,
        type_ids: &[i64],
    ) -> Result<HashMap<i64, Vec<(i64, f64)>>, SdeError> {
        if type_ids.is_empty() {
            return Ok(HashMap::new());
        }
        // Build a `(?, ?, …)` placeholder list — rusqlite has no native array bind.
        let placeholders = vec!["?"; type_ids.len()].join(", ");
        let sql = format!(
            "SELECT typeID, attributeID, COALESCE(valueFloat, valueInt)
             FROM dgmTypeAttributes WHERE typeID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(type_ids.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
            ))
        })?;
        let mut map: HashMap<i64, Vec<(i64, f64)>> = HashMap::new();
        for row in rows {
            let (type_id, attr_id, value) = row?;
            map.entry(type_id).or_default().push((attr_id, value));
        }
        Ok(map)
    }

    /// The effects attached to a type as `(effectID, isDefault)` from
    /// `dgmTypeEffects` (#159). `isDefault` marks a module's auto-selected
    /// effect (e.g. the charge a launcher fires). Also used by the EFT importer
    /// to classify a module into its slot (#162).
    pub fn type_effects(&self, type_id: i64) -> Result<Vec<(i64, bool)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT effectID, COALESCE(isDefault, 0) FROM dgmTypeEffects WHERE typeID = ?1",
        )?;
        let rows = stmt.query_map(params![type_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? != 0))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Published modules in the given groups whose meta group is allowed, for
    /// the fitting optimizer (#156). Items with no meta entry count as Tech I
    /// (metaGroup 1). Returns `(type_id, group_id)`.
    pub fn modules_in_groups(
        &self,
        group_ids: &[i64],
        allowed_meta: &[i64],
    ) -> Result<Vec<(i64, i64)>, SdeError> {
        if group_ids.is_empty() || allowed_meta.is_empty() {
            return Ok(Vec::new());
        }
        let gph = vec!["?"; group_ids.len()].join(", ");
        let mph = vec!["?"; allowed_meta.len()].join(", ");
        let sql = format!(
            "SELECT t.typeID, t.groupID
             FROM invTypes t
             LEFT JOIN invMetaTypes mt ON mt.typeID = t.typeID
             WHERE t.groupID IN ({gph}) AND t.published = 1
               AND COALESCE(mt.metaGroupID, 1) IN ({mph})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params: Vec<i64> = group_ids
            .iter()
            .chain(allowed_meta.iter())
            .copied()
            .collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Map of typeID → groupID for the given types (bulk; for the optimizer).
    pub fn types_groups(&self, type_ids: &[i64]) -> Result<HashMap<i64, i64>, SdeError> {
        if type_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; type_ids.len()].join(", ");
        let sql = format!("SELECT typeID, groupID FROM invTypes WHERE typeID IN ({placeholders})");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(type_ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(Into::into)
    }

    /// Published Skill (category 16) type ids — the "all V" skill set the
    /// fitting engine applies (#172).
    pub fn skill_type_ids(&self) -> Result<Vec<i64>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             WHERE g.categoryID = 16 AND t.published = 1",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Batched [`type_effects`](Self::type_effects): effect ids per type for many
    /// types at once (the fit + all skills), keyed by typeID (#172).
    pub fn types_effects(&self, type_ids: &[i64]) -> Result<HashMap<i64, Vec<i64>>, SdeError> {
        if type_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; type_ids.len()].join(", ");
        let sql = format!(
            "SELECT typeID, effectID FROM dgmTypeEffects WHERE typeID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(type_ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut map: HashMap<i64, Vec<i64>> = HashMap::new();
        for row in rows {
            let (type_id, effect_id) = row?;
            map.entry(type_id).or_default().push(effect_id);
        }
        Ok(map)
    }

    /// Every dogma effect with its parsed `modifierInfo`, keyed by effectID
    /// (#159). `dgmExpressions` is empty in the Fuzzwork dump, so `modifierInfo`
    /// is the engine's structured modifier source. A malformed payload is logged
    /// and skipped rather than failing the whole map.
    pub fn effect_meta(&self) -> Result<HashMap<i64, EffectMeta>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT effectID, effectName, effectCategory, isOffensive, isAssistance,
                    durationAttributeID, dischargeAttributeID, rangeAttributeID,
                    falloffAttributeID, trackingSpeedAttributeID, modifierInfo
             FROM dgmEffects",
        )?;
        let rows = stmt.query_map([], |r| {
            let meta = EffectMeta {
                effect_id: r.get(0)?,
                name: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                category: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                is_offensive: r.get::<_, Option<i64>>(3)?.unwrap_or(0) != 0,
                is_assistance: r.get::<_, Option<i64>>(4)?.unwrap_or(0) != 0,
                duration_attribute_id: r.get(5)?,
                discharge_attribute_id: r.get(6)?,
                range_attribute_id: r.get(7)?,
                falloff_attribute_id: r.get(8)?,
                tracking_speed_attribute_id: r.get(9)?,
                modifiers: Vec::new(),
            };
            let modifier_json: Option<String> = r.get(10)?;
            Ok((meta, modifier_json))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (mut meta, modifier_json) = row?;
            if let Some(json) = modifier_json.filter(|s| !s.trim().is_empty()) {
                match serde_json::from_str::<Vec<ModifierInfo>>(&json) {
                    Ok(mods) => meta.modifiers = mods,
                    Err(e) => {
                        eprintln!(
                            "effect {} has unparseable modifierInfo: {e}",
                            meta.effect_id
                        )
                    }
                }
            }
            map.insert(meta.effect_id, meta);
        }
        Ok(map)
    }

    /// Per-attribute metadata from `dgmAttributeTypes`, keyed by attributeID
    /// (#159). `stackable`/`highIsGood` drive the stacking-penalty logic.
    pub fn attribute_defaults(&self) -> Result<HashMap<i64, AttrMeta>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT attributeID, COALESCE(defaultValue, 0), COALESCE(stackable, 1),
                    COALESCE(highIsGood, 1)
             FROM dgmAttributeTypes",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(AttrMeta {
                attribute_id: r.get(0)?,
                default_value: r.get::<_, f64>(1)?,
                stackable: r.get::<_, i64>(2)? != 0,
                high_is_good: r.get::<_, i64>(3)? != 0,
            })
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let meta = row?;
            map.insert(meta.attribute_id, meta);
        }
        Ok(map)
    }

    /// A ship hull's slot layout + fitting resources for the editor (#160).
    /// Reads the relevant dogma attributes by id (verified against the SDE);
    /// `None` if the type doesn't exist.
    pub fn ship_layout(&self, type_id: i64) -> Result<Option<ShipLayout>, SdeError> {
        let name: Option<String> = self
            .conn
            .query_row(
                "SELECT typeName FROM invTypes WHERE typeID = ?1",
                params![type_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(name) = name else {
            return Ok(None);
        };
        // attributeID -> value for this hull; missing attributes default to 0.
        let attrs: HashMap<i64, f64> = self.type_attributes_raw(type_id)?.into_iter().collect();
        let a = |id: i64| attrs.get(&id).copied().unwrap_or(0.0);
        Ok(Some(ShipLayout {
            type_id,
            name,
            high_slots: a(14) as i64,           // hiSlots
            mid_slots: a(13) as i64,            // medSlots
            low_slots: a(12) as i64,            // lowSlots
            rig_slots: a(1137) as i64,          // rigSlots
            subsystem_slots: a(1367) as i64,    // maxSubSystems
            turret_hardpoints: a(102) as i64,   // turretSlotsLeft
            launcher_hardpoints: a(101) as i64, // launcherSlotsLeft
            cpu_output: a(48),                  // cpuOutput
            powergrid_output: a(11),            // powerOutput
            calibration: a(1132),               // upgradeCapacity
            drone_bay: a(283),                  // droneCapacity
            drone_bandwidth: a(1271),           // droneBandwidth
        }))
    }

    /// Search solar systems by name substring (case-insensitive), capped. For
    /// the route neighbourhood picker.
    pub fn search_systems(&self, query: &str, limit: i64) -> Result<Vec<(i64, String)>, SdeError> {
        let pattern = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare(
            "SELECT solarSystemID, solarSystemName FROM mapSolarSystems
             WHERE solarSystemName LIKE ?1
             ORDER BY LENGTH(solarSystemName), solarSystemName LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Every known-space market region `(id, name)`, sorted by name. Region ids
    /// below 11000000 are k-space (wormhole/abyssal regions start at 11000000
    /// and have no public market); a handful of these (Jove space, dev regions)
    /// trade nothing, but ESI simply returns no orders for them.
    pub fn market_regions(&self) -> Result<Vec<(i64, String)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT regionID, regionName FROM mapRegions
             WHERE regionID < 11000000 ORDER BY regionName",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Search NPC stations by name `(id, name)`, shortest-name-first. Player
    /// structures aren't in the SDE, so they're not searchable here.
    pub fn search_stations(&self, query: &str, limit: i64) -> Result<Vec<(i64, String)>, SdeError> {
        let pattern = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare(
            "SELECT stationID, stationName FROM staStations
             WHERE stationName LIKE ?1
             ORDER BY LENGTH(stationName), stationName LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The `(solar_system_id, region_id)` an NPC station sits in, if known.
    pub fn station_location(&self, station_id: i64) -> Result<Option<(i64, i64)>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT solarSystemID, regionID FROM staStations WHERE stationID = ?1")?;
        let mut rows = stmt.query(params![station_id])?;
        match rows.next()? {
            Some(r) => Ok(Some((r.get(0)?, r.get(1)?))),
            None => Ok(None),
        }
    }

    /// The region a solar system belongs to, if known.
    pub fn system_region(&self, system_id: i64) -> Result<Option<i64>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT regionID FROM mapSolarSystems WHERE solarSystemID = ?1")?;
        let mut rows = stmt.query(params![system_id])?;
        match rows.next()? {
            Some(r) => Ok(Some(r.get(0)?)),
            None => Ok(None),
        }
    }

    /// Every wormhole type (`invTypes` group 988) with its physics, read from the
    /// five `dgmTypeAttributes` rows (same correlated-subquery style as
    /// [`decryptors`](Self::decryptors)). Fully offline — no external data.
    ///
    /// Attribute ids (chruker/whtype.info): 1381 target system class, 1382 max
    /// stable time (min), 1383 max stable mass (kg), 1384 mass regen (kg), 1385
    /// max jump mass (kg). K162 has no fixed target class (attr 0/absent) → it's
    /// labelled the generic "exit (variable)" rather than a bogus destination.
    pub fn wormhole_types(&self) -> Result<Vec<WormholeType>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, t.typeName,
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1381),
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1382),
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1383),
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1384),
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1385)
             FROM invTypes t
             WHERE t.groupID = 988
             ORDER BY t.typeName",
        )?;
        let rows = stmt.query_map([], |row| {
            let raw_class: Option<f64> = row.get(2)?;
            // K162 (and any exit) has class 0/absent → variable destination.
            let dest_class_id = raw_class.map(|c| c as i64).filter(|&c| c != 0).unwrap_or(0);
            Ok(WormholeType {
                type_id: row.get(0)?,
                code: row.get(1)?,
                dest_class_id,
                dest_class_label: if dest_class_id == 0 {
                    "exit (variable)".to_string()
                } else {
                    wormhole_class_label(dest_class_id)
                },
                max_stable_time_min: row.get(3)?,
                max_stable_mass: row.get(4)?,
                mass_regen: row.get(5)?,
                max_jump_mass: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// A wormhole system's environment **effect** (Pulsar/WR/…), derived offline
    /// from its star type. Fuzzwork's classic schema carries `sunTypeID` on
    /// `mapSolarSystems`; newer conversions instead expose the star as a celestial
    /// in `mapDenormalize` (groupID 6 = Sun). We try both so we work across SDE
    /// variants — a missing column/table just falls through to "no effect", never
    /// a wrong one. Only the six effect-star types map to an effect (#314).
    pub fn system_effect(&self, system_id: i64) -> Result<Option<String>, SdeError> {
        let sun = self
            .sun_type_from_mss(system_id)
            .ok()
            .flatten()
            .or_else(|| self.sun_type_from_denorm(system_id).ok().flatten());
        Ok(sun.and_then(wormhole_effect_name))
    }

    fn sun_type_from_mss(&self, system_id: i64) -> rusqlite::Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT sunTypeID FROM mapSolarSystems WHERE solarSystemID = ?1",
                params![system_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map(Option::flatten)
    }

    fn sun_type_from_denorm(&self, system_id: i64) -> rusqlite::Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT typeID FROM mapDenormalize WHERE solarSystemID = ?1 AND groupID = 6 LIMIT 1",
                params![system_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map(Option::flatten)
    }

    /// All planetary-interaction factory schematics with their cycle time and
    /// input/output type maps (`planetSchematics` + `planetSchematicsTypeMap`).
    /// Keyed by schematic id — the PI module joins a factory pin's schematic to
    /// this to know what it consumes/produces (#PI).
    pub fn planet_schematics(&self) -> Result<HashMap<i64, PlanetSchematic>, SdeError> {
        let mut map: HashMap<i64, PlanetSchematic> = HashMap::new();
        let mut base = self
            .conn
            .prepare("SELECT schematicID, schematicName, cycleTime FROM planetSchematics")?;
        let rows = base.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (id, name, cycle_time) = row?;
            map.insert(
                id,
                PlanetSchematic {
                    schematic_id: id,
                    name,
                    cycle_time,
                    inputs: Vec::new(),
                    outputs: Vec::new(),
                },
            );
        }

        let mut tm = self.conn.prepare(
            "SELECT schematicID, typeID, quantity, isInput FROM planetSchematicsTypeMap",
        )?;
        let rows = tm.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        for row in rows {
            let (sid, tid, qty, is_input) = row?;
            if let Some(s) = map.get_mut(&sid) {
                if is_input != 0 {
                    s.inputs.push((tid, qty));
                } else {
                    s.outputs.push((tid, qty));
                }
            }
        }
        Ok(map)
    }

    /// `(volume, capacity)` in m³ for the given type ids (`invTypes`). PI uses
    /// volume to fill storage and capacity to size storage/launchpad/command pins.
    pub fn types_dims(&self, ids: &[i64]) -> Result<HashMap<i64, (f64, f64)>, SdeError> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "SELECT typeID, volume, capacity FROM invTypes WHERE typeID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                (
                    r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                    r.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                ),
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (id, dims) = row?;
            map.insert(id, dims);
        }
        Ok(map)
    }

    /// A hull's `(name, base mass in kg)` from `invTypes` — the input the jump
    /// planner (#303) weighs against a wormhole's max jump mass. Base hull mass;
    /// prop-mod effects on mass are out of scope for the planner.
    pub fn ship_mass(&self, type_id: i64) -> Result<Option<(String, f64)>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT typeName, mass FROM invTypes WHERE typeID = ?1")?;
        let mut rows = stmt.query(params![type_id])?;
        match rows.next()? {
            Some(r) => Ok(Some((
                r.get(0)?,
                r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
            ))),
            None => Ok(None),
        }
    }

    /// A J-system's wormhole class, offline. Reads `mapLocationWormholeClasses`
    /// by system id, falling back to the system's region (k-space classes are
    /// keyed at the region level). Lets us cross-check the Anoik.is snapshot (#305).
    pub fn wormhole_system_class(&self, system_id: i64) -> Result<Option<i64>, SdeError> {
        let by_location = |loc: i64| -> Result<Option<i64>, SdeError> {
            let mut stmt = self.conn.prepare(
                "SELECT wormholeClassID FROM mapLocationWormholeClasses WHERE locationID = ?1",
            )?;
            let mut rows = stmt.query(params![loc])?;
            match rows.next()? {
                Some(r) => Ok(Some(r.get(0)?)),
                None => Ok(None),
            }
        };
        if let Some(class) = by_location(system_id)? {
            return Ok(Some(class));
        }
        match self.system_region(system_id)? {
            Some(region) => by_location(region),
            None => Ok(None),
        }
    }

    /// Stargate edges `(from, to)` whose source is one of `ids` — for building a
    /// system neighbourhood by BFS. K-space only (wormhole systems have no
    /// stargates). One query; the caller walks levels.
    pub fn stargate_edges_from(&self, ids: &[i64]) -> Result<Vec<(i64, i64)>, SdeError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "SELECT fromSolarSystemID, toSolarSystemID FROM mapSolarSystemJumps
             WHERE fromSolarSystemID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// NPC station names for the given station ids (from `staStations`). Player
    /// structures (citadels) aren't in the SDE, so they're simply absent and the
    /// caller falls back to a generic label.
    pub fn station_names(&self, ids: &[i64]) -> Result<HashMap<i64, String>, SdeError> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "SELECT stationID, stationName FROM staStations WHERE stationID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (id, name) = row?;
            map.insert(id, name);
        }
        Ok(map)
    }

    /// Every stargate edge `(from, to)` in known space — the full adjacency for
    /// in-memory route BFS (~13k rows). Cross-chain routing unions wormhole
    /// connections onto this.
    pub fn all_stargate_edges(&self) -> Result<Vec<(i64, i64)>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT fromSolarSystemID, toSolarSystemID FROM mapSolarSystemJumps")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Map of solar system id -> (name, security, region name). For the route /
    /// system-activity view. `security` is the raw SDE float (−1.0 … 1.0).
    pub fn solar_system_info(&self) -> Result<HashMap<i64, (String, f64, String)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT s.solarSystemID, s.solarSystemName, s.security, r.regionName
             FROM mapSolarSystems s
             LEFT JOIN mapRegions r ON r.regionID = s.regionID",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                (
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                ),
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (id, info) = row?;
            map.insert(id, info);
        }
        Ok(map)
    }

    /// Map of solar system id -> name (for mining ledger / fleet).
    pub fn system_names(&self) -> Result<HashMap<i64, String>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT solarSystemID, solarSystemName FROM mapSolarSystems")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<HashMap<_, _>, _>>()
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

/// Label a wormhole destination class id (`wormholeClassID` / target-class attr).
/// C1–C6 are the wormhole space classes; 7/8/9 are k-space security bands; the
/// rest are special spaces. Unknown ids pass through as `class {id}`.
pub fn wormhole_class_label(id: i64) -> String {
    match id {
        1..=6 => format!("C{id}"),
        7 => "HS".to_string(),
        8 => "LS".to_string(),
        9 => "NS".to_string(),
        12 => "Thera".to_string(),
        13 => "C13".to_string(),
        14..=18 => "Drifter".to_string(),
        25 => "Pochven".to_string(),
        _ => format!("class {id}"),
    }
}

/// Map a wormhole system's star (sun) type id to its environment effect. Only the
/// six effect-star types match; k-space spectral suns (incl. the *spectral* "Red
/// Giant" sun, id 8) and effect-less holes return `None`. Pure.
pub fn wormhole_effect_name(sun_type_id: i64) -> Option<String> {
    Some(
        match sun_type_id {
            30574 => "Magnetar",
            30575 => "Black Hole",
            30576 => "Red Giant",
            30577 => "Pulsar",
            30669 => "Wolf-Rayet",
            30670 => "Cataclysmic Variable",
            _ => return None,
        }
        .to_string(),
    )
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

    /// A tiny in-memory SDE: blueprint 999 builds 1x Widget (100) from
    /// 40x Tritanium (200) + 10x Pyerite (300).
    fn fixture() -> Sde {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
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
        .unwrap();
        Sde::from_connection(conn)
    }

    #[test]
    fn returns_manufacturing_materials_only() {
        let sde = fixture();
        let mats = sde.blueprint_materials(999).unwrap();
        assert_eq!(
            mats,
            vec![
                BlueprintMaterial {
                    material_type_id: 200,
                    name: "Tritanium".into(),
                    quantity: 40
                },
                BlueprintMaterial {
                    material_type_id: 300,
                    name: "Pyerite".into(),
                    quantity: 10
                },
            ]
        );
    }

    #[test]
    fn decryptors_read_modifiers_from_attributes() {
        // Self-contained: invTypes needs `published`, which the shared fixture omits.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL, published INT);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL);
             INSERT INTO invTypes VALUES
               (34201, 1, 'Accelerant Decryptor', 0.1, 1),
               (34203, 1, 'Augmentation Decryptor', 0.1, 1),
               (99999, 1, 'Unpublished Decryptor', 0.1, 0),
               (100, 1, 'Tritanium', 0.1, 1);
             -- 1112 = probability mult, 1113 = ME modifier, 1124 = run modifier.
             INSERT INTO dgmTypeAttributes VALUES
               (34201, 1112, 1.2), (34201, 1113, 2.0), (34201, 1124, 1.0),
               (34203, 1112, 0.6), (34203, 1113, -2.0), (34203, 1124, 9.0);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

        let decs = sde.decryptors().unwrap();
        // Only published items whose name contains "Decryptor", ordered by name.
        assert_eq!(decs.len(), 2);
        assert_eq!(decs[0].name, "Accelerant Decryptor");
        assert_eq!(decs[0].type_id, 34201);
        assert!((decs[0].probability_multiplier - 1.2).abs() < 1e-9);
        assert_eq!(decs[0].me_modifier, 2);
        assert_eq!(decs[0].run_modifier, 1);
        assert_eq!(decs[1].name, "Augmentation Decryptor");
        assert_eq!(decs[1].me_modifier, -2);
        assert_eq!(decs[1].run_modifier, 9);
    }

    #[test]
    fn wormhole_types_read_physics_and_handle_k162() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL);
             INSERT INTO invTypes VALUES
               (30832, 988, 'N766', 0.0),   -- C2-static (to C2)
               (30371, 988, 'K162', 0.0),   -- generic exit (no target class)
               (99, 55, 'Not A Wormhole', 0.0);
             -- 1381 target class, 1382 stable time, 1383 stable mass, 1384 regen, 1385 jump mass.
             INSERT INTO dgmTypeAttributes VALUES
               (30832, 1381, 2.0), (30832, 1382, 1440.0), (30832, 1383, 2000000000.0),
               (30832, 1384, 0.0), (30832, 1385, 300000000.0),
               (30371, 1382, 1440.0), (30371, 1383, 3000000000.0), (30371, 1385, 1000000000.0);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

        let whs = sde.wormhole_types().unwrap();
        // Only group-988 rows, ordered by code (K162 before N766).
        assert_eq!(whs.len(), 2);
        assert_eq!(whs[0].code, "K162");
        assert_eq!(whs[1].code, "N766");

        let n766 = &whs[1];
        assert_eq!(n766.dest_class_id, 2);
        assert_eq!(n766.dest_class_label, "C2");
        assert_eq!(n766.max_jump_mass, Some(300_000_000.0));
        assert_eq!(n766.max_stable_mass, Some(2_000_000_000.0));
        assert_eq!(n766.max_stable_time_min, Some(1440.0));

        // K162: no target class → variable exit, not a bogus destination.
        let k162 = &whs[0];
        assert_eq!(k162.dest_class_id, 0);
        assert_eq!(k162.dest_class_label, "exit (variable)");
        assert_eq!(k162.max_jump_mass, Some(1_000_000_000.0));
    }

    #[test]
    fn wormhole_class_labels() {
        assert_eq!(wormhole_class_label(1), "C1");
        assert_eq!(wormhole_class_label(6), "C6");
        assert_eq!(wormhole_class_label(7), "HS");
        assert_eq!(wormhole_class_label(8), "LS");
        assert_eq!(wormhole_class_label(9), "NS");
        assert_eq!(wormhole_class_label(12), "Thera");
        assert_eq!(wormhole_class_label(25), "Pochven");
        assert_eq!(wormhole_class_label(99), "class 99");
    }

    #[test]
    fn planet_schematics_split_inputs_and_outputs() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE planetSchematics(schematicID INT, schematicName TEXT, cycleTime INT);
             CREATE TABLE planetSchematicsTypeMap(schematicID INT, typeID INT, quantity INT, isInput INT);
             INSERT INTO planetSchematics VALUES (65, 'Water', 3600);
             -- Water: 3000 Aqueous Liquids (2309, input) → 20 Water (2389, output).
             INSERT INTO planetSchematicsTypeMap VALUES (65, 2309, 3000, 1), (65, 2389, 20, 0);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);
        let map = sde.planet_schematics().unwrap();
        let s = &map[&65];
        assert_eq!(s.name, "Water");
        assert_eq!(s.cycle_time, 3600);
        assert_eq!(s.inputs, vec![(2309, 3000)]);
        assert_eq!(s.outputs, vec![(2389, 20)]);
    }

    #[test]
    fn wormhole_effect_maps_only_effect_star_types() {
        assert_eq!(wormhole_effect_name(30577).as_deref(), Some("Pulsar"));
        assert_eq!(wormhole_effect_name(30574).as_deref(), Some("Magnetar"));
        assert_eq!(
            wormhole_effect_name(30670).as_deref(),
            Some("Cataclysmic Variable")
        );
        // The spectral k-space "Sun K5 (Red Giant)" (id 8) is NOT an effect.
        assert_eq!(wormhole_effect_name(8), None);
        assert_eq!(wormhole_effect_name(0), None);
    }

    #[test]
    fn system_effect_reads_sun_type() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE mapSolarSystems(solarSystemID INT, sunTypeID INT);
             INSERT INTO mapSolarSystems VALUES (31000100, 30577), (31000200, 8), (31000300, NULL);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);
        assert_eq!(
            sde.system_effect(31000100).unwrap().as_deref(),
            Some("Pulsar")
        );
        // Spectral red-giant sun → no wormhole effect.
        assert_eq!(sde.system_effect(31000200).unwrap(), None);
        // No sun / unknown system → None, no error.
        assert_eq!(sde.system_effect(31000300).unwrap(), None);
        assert_eq!(sde.system_effect(39999999).unwrap(), None);
    }

    #[test]
    fn wormhole_system_class_falls_back_to_region() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE mapSolarSystems(solarSystemID INT, regionID INT);
             CREATE TABLE mapLocationWormholeClasses(locationID INT, wormholeClassID INT);
             INSERT INTO mapSolarSystems VALUES (31000005, 11000031), (30000142, 10000002);
             -- J-system keyed directly; k-space keyed at the region.
             INSERT INTO mapLocationWormholeClasses VALUES (31000005, 12), (10000002, 7);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);
        // Thera by direct system id.
        assert_eq!(sde.wormhole_system_class(31000005).unwrap(), Some(12));
        // Jita resolves via its region (The Forge → HS class 7).
        assert_eq!(sde.wormhole_system_class(30000142).unwrap(), Some(7));
        // Unknown system → None.
        assert_eq!(sde.wormhole_system_class(30009999).unwrap(), None);
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

    #[test]
    fn finds_only_loadable_charges() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT, typeName TEXT, groupID INT, published INT, volume REAL, capacity REAL);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL);
             CREATE TABLE invMetaTypes(typeID INT, parentTypeID INT, metaGroupID INT);

             -- Weapon 100: chargeGroup1=83, chargeSize=2 (medium), capacity 1.5.
             INSERT INTO invTypes VALUES (100,'220mm AutoCannon',55,1,5.0,1.5);
             INSERT INTO dgmTypeAttributes VALUES (100,604,83.0),(100,128,2.0);

             -- Charges: right group+size+fits; right group wrong size; wrong group;
             -- right but too big; right but unpublished.
             INSERT INTO invTypes VALUES
               (1,'EMP M',83,1,0.0125,0),
               (2,'Phased Plasma M T2',83,1,0.0125,0),
               (3,'EMP S',83,1,0.0125,0),   -- wrong size (1)
               (4,'Mining Crystal',600,1,0.0125,0), -- wrong group
               (5,'Huge Charge',83,1,99.0,0),       -- too big for capacity
               (6,'Unpublished M',83,0,0.0125,0);   -- unpublished
             INSERT INTO dgmTypeAttributes VALUES
               (1,128,2.0),(2,128,2.0),(3,128,1.0),(5,128,2.0),(6,128,2.0);
             INSERT INTO invMetaTypes VALUES (2,1,2); -- T2 sorts after T1",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

        let charges = sde.compatible_charges(100).unwrap();
        let names: Vec<_> = charges.iter().map(|(_, n)| n.as_str()).collect();
        // Only the right-group, right-size, fitting, published charges — T1 then T2.
        assert_eq!(names, vec!["EMP M", "Phased Plasma M T2"]);

        // A module with no chargeGroup attrs takes no charge.
        assert!(sde.compatible_charges(1).unwrap().is_empty());
    }

    #[test]
    fn search_matches_terms_in_any_order() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT, typeName TEXT, marketGroupID INT, published INT);
             INSERT INTO invTypes VALUES
               (1, 'Large Shield Hardener', 10, 1),
               (2, 'Small Shield Booster', 10, 1),
               (3, 'Damage Control II', 10, 1),
               (4, 'Unpublished Shield Hardener', 10, 0);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

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
    fn returns_product() {
        let sde = fixture();
        let product = sde.blueprint_product(999).unwrap().unwrap();
        assert_eq!(
            product,
            BlueprintProduct {
                product_type_id: 100,
                name: "Widget".into(),
                quantity: 1
            }
        );
    }

    #[test]
    fn product_is_none_for_non_blueprint() {
        let sde = fixture();
        assert!(sde.blueprint_product(100).unwrap().is_none());
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
    fn recipe_for_manufacturing_and_reaction() {
        let sde = fixture();
        let mfg = sde.recipe_for(100).unwrap().unwrap();
        assert_eq!(mfg.blueprint_type_id, 999);
        assert_eq!(mfg.activity_id, 1);
        assert_eq!(mfg.product_quantity, 1);
        assert_eq!(mfg.materials.len(), 2);

        let rxn = sde.recipe_for(600).unwrap().unwrap();
        assert_eq!(rxn.blueprint_type_id, 9000);
        assert_eq!(rxn.activity_id, 11);
        assert_eq!(rxn.product_quantity, 100);
        assert_eq!(rxn.materials[0].material_type_id, 200);

        // A raw mineral has no recipe.
        assert!(sde.recipe_for(200).unwrap().is_none());
    }

    #[test]
    fn finds_invention_for_t2_blueprint() {
        let sde = fixture();
        let inv = sde.invention_for(999).unwrap().unwrap();
        assert_eq!(inv.inventing_blueprint_type_id, 998);
        assert_eq!(inv.runs_per_success, 10);
        assert_eq!(inv.probability, 0.3);
        assert_eq!(inv.datacores.len(), 1);
        assert_eq!(inv.datacores[0].material_type_id, 500);
        assert_eq!(inv.datacores[0].quantity, 2);
        // T2 is invented from a T1 blueprint (copied), not a consumed relic.
        assert!(inv.relic.is_none());
    }

    #[test]
    fn finds_relic_for_t3_invention() {
        // Self-contained: needs an inventing type in the 'Ancient Relics' category.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invCategories(categoryID INT, categoryName TEXT);
             CREATE TABLE invGroups(groupID INT, categoryID INT, groupName TEXT);
             CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL);
             CREATE TABLE industryActivityProducts(typeID INT, activityID INT, productTypeID INT, quantity INT);
             CREATE TABLE industryActivityProbabilities(typeID INT, activityID INT, productTypeID INT, probability REAL);
             CREATE TABLE industryActivityMaterials(typeID INT, activityID INT, materialTypeID INT, quantity INT);

             INSERT INTO invCategories VALUES (34, 'Ancient Relics'), (6, 'Ship');
             INSERT INTO invGroups VALUES (970, 34, 'Sleeper Hull Relics'), (963, 6, 'Strategic Cruiser');
             INSERT INTO invTypes VALUES
               (30752, 970, 'Intact Hull Section', 1.0),
               (29984, 963, 'Tengu Blueprint', 0.01),
               (20412, 970, 'Datacore - Plasma Physics', 0.1);
             -- Relic 30752 invents the Tengu BP (29984): 20 runs, 26%, 3 datacores.
             INSERT INTO industryActivityProducts VALUES (30752, 8, 29984, 20);
             INSERT INTO industryActivityProbabilities VALUES (30752, 8, 29984, 0.26);
             INSERT INTO industryActivityMaterials VALUES (30752, 8, 20412, 3);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

        let inv = sde.invention_for(29984).unwrap().unwrap();
        assert_eq!(inv.inventing_blueprint_type_id, 30752);
        assert_eq!(inv.runs_per_success, 20);
        let relic = inv.relic.expect("T3 invention should carry a relic");
        assert_eq!(relic.material_type_id, 30752);
        assert_eq!(relic.name, "Intact Hull Section");
        assert_eq!(relic.quantity, 1);
    }

    #[test]
    fn no_invention_for_t1_blueprint() {
        let sde = fixture();
        // 998 is the T1 inventing BP — nothing invents it.
        assert!(sde.invention_for(998).unwrap().is_none());
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

    /// A tiny market fixture: Ship (cat 6), Module (cat 7), Charge (cat 8), plus
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

    #[test]
    fn lists_manufacturable_blueprints() {
        let sde = fixture();
        let bps = sde.manufacturable_blueprints().unwrap();
        assert_eq!(bps.len(), 1);
        assert_eq!(bps[0].blueprint_type_id, 999);
        assert_eq!(bps[0].product_type_id, 100);
    }

    /// A tiny dogma fixture: a hull (587) with slots/resources and a damage
    /// module (519) carrying a `LocationGroupModifier` effect, plus the
    /// attribute/effect metadata tables. Mirrors the real SDE shapes (#158–#160).
    fn dogma_fixture() -> Sde {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL, published INT);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL, valueInt INT);
             CREATE TABLE dgmAttributeTypes(attributeID INT, attributeName TEXT, defaultValue REAL, stackable INT, highIsGood INT);
             CREATE TABLE dgmTypeEffects(typeID INT, effectID INT, isDefault INT);
             CREATE TABLE dgmEffects(effectID INT, effectName TEXT, effectCategory INT, isOffensive INT, isAssistance INT, durationAttributeID INT, dischargeAttributeID INT, rangeAttributeID INT, falloffAttributeID INT, trackingSpeedAttributeID INT, modifierInfo TEXT);

             INSERT INTO invTypes VALUES (587, 25, 'Rifter', 27.0, 1), (519, 60, 'Gyrostabilizer II', 5.0, 1);
             INSERT INTO dgmTypeAttributes(typeID, attributeID, valueFloat) VALUES
               (587,14,3),(587,13,3),(587,12,4),(587,1137,3),(587,102,3),(587,101,2),
               (587,48,130),(587,11,41),(587,1132,400),(587,283,0),(587,1271,0),
               (519,64,1.1);
             INSERT INTO dgmAttributeTypes VALUES
               (64,'damageMultiplier',1.0,0,1),
               (48,'cpuOutput',0.0,1,1);
             INSERT INTO dgmTypeEffects VALUES (519, 92, 1);
             INSERT INTO dgmEffects VALUES
               (92,'projectileWeaponDamageMultiply',1,0,0,NULL,NULL,NULL,NULL,NULL,
                '[{\"domain\": \"shipID\", \"func\": \"LocationGroupModifier\", \"groupID\": 55, \"modifiedAttributeID\": 64, \"modifyingAttributeID\": 64, \"operation\": 4}]'),
               (16,'online',0,0,0,NULL,NULL,NULL,NULL,NULL,NULL);",
        )
        .unwrap();
        Sde::from_connection(conn)
    }

    #[test]
    fn raw_attributes_by_id_single_and_batch() {
        let sde = dogma_fixture();
        let single: HashMap<i64, f64> = sde.type_attributes_raw(587).unwrap().into_iter().collect();
        assert_eq!(single.get(&14), Some(&3.0));
        assert_eq!(single.get(&48), Some(&130.0));

        let batch = sde.types_attributes_raw(&[587, 519]).unwrap();
        assert_eq!(batch.len(), 2);
        assert!(batch[&519]
            .iter()
            .any(|&(id, v)| id == 64 && (v - 1.1).abs() < 1e-9));
        assert!(sde.types_attributes_raw(&[]).unwrap().is_empty());
    }

    #[test]
    fn type_effects_and_effect_meta_parse_modifier_info() {
        let sde = dogma_fixture();
        assert_eq!(sde.type_effects(519).unwrap(), vec![(92, true)]);

        let meta = sde.effect_meta().unwrap();
        let dmg = meta.get(&92).unwrap();
        assert_eq!(dmg.name, "projectileWeaponDamageMultiply");
        assert_eq!(dmg.modifiers.len(), 1);
        let m = &dmg.modifiers[0];
        assert_eq!(m.func.as_deref(), Some("LocationGroupModifier"));
        assert_eq!(m.group_id, Some(55));
        assert_eq!(m.modified_attribute_id, Some(64));
        assert_eq!(m.operation, Some(4));
        // An effect with no modifierInfo parses to zero modifiers.
        assert!(meta.get(&16).unwrap().modifiers.is_empty());
    }

    #[test]
    fn attribute_defaults_expose_stacking_flags() {
        let sde = dogma_fixture();
        let defs = sde.attribute_defaults().unwrap();
        let dmg = defs.get(&64).unwrap();
        assert_eq!(dmg.default_value, 1.0);
        assert!(!dmg.stackable); // stackable = 0 -> penalized
        assert!(dmg.high_is_good);
    }

    #[test]
    fn ship_layout_reads_slots_and_resources() {
        let sde = dogma_fixture();
        let layout = sde.ship_layout(587).unwrap().unwrap();
        assert_eq!(layout.name, "Rifter");
        assert_eq!(layout.high_slots, 3);
        assert_eq!(layout.mid_slots, 3);
        assert_eq!(layout.low_slots, 4);
        assert_eq!(layout.rig_slots, 3);
        assert_eq!(layout.turret_hardpoints, 3);
        assert_eq!(layout.launcher_hardpoints, 2);
        assert_eq!(layout.cpu_output, 130.0);
        assert_eq!(layout.powergrid_output, 41.0);
        assert_eq!(layout.calibration, 400.0);
        assert!(sde.ship_layout(424242).unwrap().is_none());
    }
}
