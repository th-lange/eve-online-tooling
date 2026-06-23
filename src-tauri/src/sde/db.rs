//! Read-only query layer over the SDE SQLite database.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;

use super::types::{
    activity, BlueprintMaterial, BlueprintProduct, InventionData, ManufacturableBlueprint, TypeInfo,
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

    /// Manufacturing inputs (activity 1) for a blueprint, with material names.
    pub fn blueprint_materials(
        &self,
        blueprint_type_id: i64,
    ) -> Result<Vec<BlueprintMaterial>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT iam.materialTypeID, t.typeName, iam.quantity
             FROM industryActivityMaterials iam
             JOIN invTypes t ON t.typeID = iam.materialTypeID
             WHERE iam.typeID = ?1 AND iam.activityID = ?2
             ORDER BY iam.materialTypeID",
        )?;
        let rows = stmt.query_map(params![blueprint_type_id, activity::MANUFACTURING], |row| {
            Ok(BlueprintMaterial {
                material_type_id: row.get(0)?,
                name: row.get(1)?,
                quantity: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
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

        Ok(Some(InventionData {
            inventing_blueprint_type_id,
            runs_per_success,
            probability,
            datacores,
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
               (998, 10, 'Widget I Blueprint', 0.01),
               (999, 10, 'Widget Blueprint', 0.01);
             INSERT INTO industryActivityProducts VALUES (999, 1, 100, 1);
             INSERT INTO industryActivityMaterials VALUES (999, 1, 200, 40), (999, 1, 300, 10);
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
    fn finds_invention_for_t2_blueprint() {
        let sde = fixture();
        let inv = sde.invention_for(999).unwrap().unwrap();
        assert_eq!(inv.inventing_blueprint_type_id, 998);
        assert_eq!(inv.runs_per_success, 10);
        assert_eq!(inv.probability, 0.3);
        assert_eq!(inv.datacores.len(), 1);
        assert_eq!(inv.datacores[0].material_type_id, 500);
        assert_eq!(inv.datacores[0].quantity, 2);
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
