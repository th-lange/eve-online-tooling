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
}
