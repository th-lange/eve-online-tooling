//! Mutaplasmid roll data (#876): which base module types a mutaplasmid can
//! be applied to, and the min/max multiplier range it rolls for each
//! attribute it touches.
//!
//! **Not queryable from the relational SQLite SDE this app downloads.**
//! Verified empirically against the live Fuzzwork dump (`latest-sqlite.db.gz`,
//! the exact file [`super::super::SDE_URL`] fetches): mutaplasmid item types
//! exist in `invTypes` (group 1964, "Mutaplasmids") with flavor-text
//! descriptions only, and carry *zero* `dgmTypeAttributes` rows — the roll
//! ranges live exclusively in CCP's `dynamicitemattributes.yaml`, a nested
//! FSD file (mutaplasmid id -> `{inputOutputMapping, attributeIDs}`) that
//! Fuzzwork's relational conversion never flattens into a table (confirmed
//! against its full 177-table schema). This is the same "genuinely not
//! queryable from the bundled SDE" situation issue #876 called out.
//!
//! Rather than teaching the app a second live SDE download pipeline for one
//! ~500KB file, this module bundles a point-in-time mirror of that CCP file
//! as a static asset (`data/dynamic_item_attributes.json`, fetched from
//! `sde.hoboleaks.space` — a third-party mirror of CCP's own published SDE,
//! same relationship Fuzzwork has to the relational tables; no Pyfa data or
//! code involved). Mutaplasmid rolls are added rarely enough (a handful of
//! times a year, alongside new abyssal module lines) that a periodic manual
//! refresh of this asset is the right tradeoff against a whole second
//! download/verify/cache subsystem for the main SDE's sibling.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;

use super::super::types::MutaplasmidRoll;
use super::super::SdeError;
use super::Sde;

/// Raw `dynamicitemattributes.yaml` shapes, as mirrored to JSON.
#[derive(Debug, Deserialize)]
struct RawRange {
    min: f64,
    max: f64,
}

#[derive(Debug, Deserialize)]
struct RawMapping {
    #[serde(rename = "applicableTypes")]
    applicable_types: Vec<i64>,
}

#[derive(Debug, Deserialize)]
struct RawEntry {
    #[serde(rename = "inputOutputMapping")]
    input_output_mapping: Vec<RawMapping>,
    #[serde(rename = "attributeIDs")]
    attribute_ids: HashMap<String, RawRange>,
}

const RAW_JSON: &str = include_str!("../data/dynamic_item_attributes.json");

/// Parsed once, process-wide — the bundled asset never changes at runtime.
static DATA: LazyLock<HashMap<i64, RawEntry>> = LazyLock::new(|| {
    serde_json::from_str(RAW_JSON)
        .expect("bundled src-tauri/src/sde/data/dynamic_item_attributes.json is malformed")
});

impl Sde {
    /// Every mutaplasmid that can be applied to `base_type_id`, with its roll
    /// ranges and display name — for the module editor's mutaplasmid picker.
    pub fn mutaplasmids_for_base_type(
        &self,
        base_type_id: i64,
    ) -> Result<Vec<MutaplasmidRoll>, SdeError> {
        let ids: Vec<i64> = DATA
            .iter()
            .filter(|(_, e)| {
                e.input_output_mapping
                    .first()
                    .is_some_and(|m| m.applicable_types.contains(&base_type_id))
            })
            .map(|(id, _)| *id)
            .collect();
        self.mutaplasmid_rolls(&ids)
    }

    /// One mutaplasmid's roll data by its own type id (`None` if it isn't a
    /// mutaplasmid, or applies to nothing in this SDE generation).
    pub fn mutaplasmid_roll(
        &self,
        mutaplasmid_type_id: i64,
    ) -> Result<Option<MutaplasmidRoll>, SdeError> {
        Ok(self
            .mutaplasmid_rolls(&[mutaplasmid_type_id])?
            .into_iter()
            .next())
    }

    /// Batch-resolve mutaplasmid roll data + display names for a set of
    /// mutaplasmid type ids, skipping any id that isn't one.
    fn mutaplasmid_rolls(&self, ids: &[i64]) -> Result<Vec<MutaplasmidRoll>, SdeError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let names: HashMap<i64, String> = self.type_names(ids)?.into_iter().collect();
        Ok(ids
            .iter()
            .filter_map(|id| {
                let entry = DATA.get(id)?;
                let mapping = entry.input_output_mapping.first()?;
                Some(MutaplasmidRoll {
                    mutaplasmid_type_id: *id,
                    mutaplasmid_name: names
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| format!("Type {id}")),
                    applicable_type_ids: mapping.applicable_types.clone(),
                    attribute_ranges: entry
                        .attribute_ids
                        .iter()
                        .filter_map(|(k, v)| k.parse::<i64>().ok().map(|aid| (aid, (v.min, v.max))))
                        .collect(),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bundled asset parses and carries at least the well-known 50MN MWD
    /// mutaplasmids (verified against the live SDE, see module doc).
    #[test]
    fn bundled_asset_parses_and_has_known_entries() {
        assert!(DATA.len() > 100);
        // "Unstable 50MN Microwarpdrive Mutaplasmid", typeID 47297.
        let entry = DATA.get(&47297).expect("known mutaplasmid missing");
        assert!(!entry.input_output_mapping.is_empty());
        assert!(entry.attribute_ids.contains_key("50")); // cpu
    }
}
