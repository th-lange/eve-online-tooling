use rusqlite::params;
#[cfg(test)]
use rusqlite::Connection;
use std::collections::HashMap;

use super::super::types::PlanetSchematic;
use super::super::SdeError;
use super::Sde;

impl Sde {
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

    /// Search published Planetary Commodities (category 43: P1–P4) by name
    /// substring, capped. For the production-chain planner's item picker
    /// (#882) — P0 raw resources (category 42) have no schematic, so aren't
    /// valid planner targets.
    pub fn search_pi_commodities(
        &self,
        query: &str,
        limit: i64,
    ) -> Result<Vec<(i64, String)>, SdeError> {
        let pattern = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, t.typeName FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             WHERE g.categoryID = 43 AND t.published = 1 AND t.typeName LIKE ?1
             ORDER BY LENGTH(t.typeName), t.typeName LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
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
                    // invTypes.volume/capacity are NULL for types with no
                    // physical volume or no internal bay (e.g. blueprints,
                    // skills) — 0 m³ is the correct value there, not a
                    // placeholder for missing data (#811).
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn search_pi_commodities_scopes_to_category_43() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invGroups(groupID INT, categoryID INT);
             CREATE TABLE invTypes(typeID INT, typeName TEXT, groupID INT, published INT);
             INSERT INTO invGroups VALUES (1042, 43), (42, 42);
             INSERT INTO invTypes VALUES
               (2398, 'Reactive Metals', 1042, 1),
               (2267, 'Base Metals', 42, 1);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);
        let hits = sde.search_pi_commodities("metal", 10).unwrap();
        // "Base Metals" matches by name but is category 42 (P0, no
        // schematic) — excluded, only the P1 (category 43) commodity hits.
        assert_eq!(hits, vec![(2398, "Reactive Metals".to_string())]);
    }
}
