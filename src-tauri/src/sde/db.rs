//! Read-only query layer over the SDE SQLite database.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;

use super::types::{
    activity, BlueprintMaterial, BlueprintProduct, Decryptor, InventionData,
    ManufacturableBlueprint, MarketItem, Recipe, ReprocessRecipe, TypeInfo,
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

    /// All published items that appear on the market (for trading modules).
    pub fn market_items(&self) -> Result<Vec<MarketItem>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT typeID, typeName, volume FROM invTypes
             WHERE published = 1 AND marketGroupID IS NOT NULL
             ORDER BY typeID",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(MarketItem {
                type_id: row.get(0)?,
                name: row.get(1)?,
                volume: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
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
        rows.collect::<Result<HashMap<_, _>, _>>().map_err(Into::into)
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn lists_manufacturable_blueprints() {
        let sde = fixture();
        let bps = sde.manufacturable_blueprints().unwrap();
        assert_eq!(bps.len(), 1);
        assert_eq!(bps[0].blueprint_type_id, 999);
        assert_eq!(bps[0].product_type_id, 100);
    }
}
