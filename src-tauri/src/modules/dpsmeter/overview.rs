//! Overview-export-aware extraction plan (#869).
//!
//! `extract_actor` (see [`super::parser`]) hardcodes EVE's **default**
//! overview layout: `NAME[CORP](SHIP)`. Custom overview packs (Z-S,
//! SaraShawa, …) reorder those fields and/or change which are shown and what
//! separators surround them, which silently breaks per-pilot/per-weapon
//! attribution for anyone not running the stock overview.
//!
//! This module turns a user's *overview export* — a YAML file the EVE client
//! itself writes from the overview settings window's "Export Overview
//! Settings" button (Misc tab) — into an [`ExtractionPlan`]: an ordered list
//! of the fields the user's ship labels actually render, with their `pre`/
//! `post` separators. [`super::parser::extract_actor`] walks that plan
//! against the final `<b>…</b>` block instead of assuming the default shape.
//!
//! # License boundary
//!
//! PyEveLiveDPS (GPL-3.0) solves the same problem with `createOverviewRegex`,
//! which reads the same `shipLabels`/`shipLabelOrder` export structure. That
//! structure is CCP's own client-generated game data, not PELD's code — its
//! field names and shape are documented independently by the (community,
//! non-GPL) EVE University wiki's "Overview manipulation" page. Only the
//! *approach* (export → field order/separators → extraction plan) is ported
//! here; the parsing below is a fresh implementation against that documented
//! YAML shape, not a translation of PELD's Python.
//!
//! # Export shape
//!
//! The export's `shipLabelOrder` is a flat sequence of label keys (plain
//! strings like `"pilot name"`, or YAML `null` for one reserved slot EVE
//! always includes); `shipLabels` is a sequence of `[key, attrs]` pairs
//! (PyYAML's list-of-tuples rendering of an ordered mapping), where `attrs`
//! is itself a sequence of `[attrName, value]` pairs carrying `pre`, `post`,
//! `state` (1 = shown, 0 = hidden), and `type`. This module reads that
//! structure with `serde_yaml::Value` rather than deriving a `Deserialize`
//! struct — the tuple-of-tuples shape doesn't map cleanly onto Serde's model
//! for real maps/structs.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

/// A ship-label field EVE's overview can render. `Other` covers any label
/// key this module doesn't need to capture (`faction`, security status,
/// custom packs' extra slots, the unnamed `null` reserved slot, …) — its
/// separators still occupy space in the rendered block, so the plan keeps
/// it around for cursor tracking even though [`super::parser`] never reads
/// its value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LabelField {
    PilotName,
    ShipType,
    ShipName,
    Corporation,
    Alliance,
    Other,
}

impl LabelField {
    /// Map an overview export's label key (`"pilot name"`, `"ship type"`, …)
    /// to the field it represents. Unknown keys — and the `null` reserved
    /// slot's absent key — become [`LabelField::Other`], never dropped
    /// outright, so the plan still accounts for their separators.
    fn from_key(key: Option<&str>) -> Self {
        match key {
            Some("pilot name") => Self::PilotName,
            Some("ship type") => Self::ShipType,
            Some("ship name") => Self::ShipName,
            Some("corporation") => Self::Corporation,
            Some("alliance") => Self::Alliance,
            _ => Self::Other,
        }
    }
}

/// One enabled label in a user's overview export, in `shipLabelOrder`'s
/// order: which field it is and the literal text EVE renders immediately
/// before/after its value. Disabled labels (`state: 0`) never reach this
/// struct — they're filtered out while building the [`ExtractionPlan`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanField {
    pub field: LabelField,
    #[serde(default)]
    pub pre: String,
    #[serde(default)]
    pub post: String,
}

/// The ordered pilot/ship label layout parsed from a user's overview export.
/// Stored alongside the rest of the DPS meter's settings and threaded into
/// [`super::parser::parse_line_with_plan`]; `None`/an empty plan leaves
/// [`super::parser::extract_actor`]'s default-format scan untouched.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionPlan {
    pub fields: Vec<PlanField>,
}

/// Read one `[attrName, value]` pair sequence into a lookup by attribute
/// name. Malformed/short pairs are skipped rather than erroring — an export
/// with an extra or reordered attribute should still yield whatever `pre`/
/// `post`/`state` it does carry.
fn attr_map(attrs: &Value) -> HashMap<&str, &Value> {
    let mut out = HashMap::new();
    let Some(seq) = attrs.as_sequence() else {
        return out;
    };
    for attr in seq {
        let Some(pair) = attr.as_sequence() else {
            continue;
        };
        if pair.len() != 2 {
            continue;
        }
        if let Some(name) = pair[0].as_str() {
            out.insert(name, &pair[1]);
        }
    }
    out
}

/// Parse an EVE overview export (YAML) into an [`ExtractionPlan`]: walk
/// `shipLabelOrder`, keep only the labels `shipLabels` marks `state: 1`, and
/// record each one's `pre`/`post` separators and field identity. Returns an
/// error string (surfaced to the settings UI) if the file isn't a valid
/// overview export — missing either top-level key, or malformed shapes for
/// them.
pub fn parse_overview_export(yaml: &str) -> Result<ExtractionPlan, String> {
    let root: Value = serde_yaml::from_str(yaml).map_err(|e| format!("invalid YAML: {e}"))?;

    let order = root
        .get("shipLabelOrder")
        .and_then(Value::as_sequence)
        .ok_or("not an overview export: missing shipLabelOrder")?;

    let labels_seq = root
        .get("shipLabels")
        .and_then(Value::as_sequence)
        .ok_or("not an overview export: missing shipLabels")?;

    // Key (`None` for the reserved `null` slot) -> (pre, post, enabled).
    let mut labels: HashMap<Option<String>, (String, String, bool)> = HashMap::new();
    for entry in labels_seq {
        let pair = entry
            .as_sequence()
            .ok_or("malformed shipLabels entry: expected a [key, attrs] pair")?;
        if pair.len() != 2 {
            continue;
        }
        let key = pair[0].as_str().map(str::to_string);
        let attrs = attr_map(&pair[1]);
        let pre = attrs
            .get("pre")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let post = attrs
            .get("post")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let state = attrs.get("state").and_then(|v| v.as_i64()) == Some(1);
        labels.insert(key, (pre, post, state));
    }

    let mut fields = Vec::new();
    for entry in order {
        let key = entry.as_str().map(str::to_string);
        let Some((pre, post, state)) = labels.get(&key) else {
            continue; // label named in the order but absent from shipLabels
        };
        if !state {
            continue;
        }
        fields.push(PlanField {
            field: LabelField::from_key(key.as_deref()),
            pre: pre.clone(),
            post: post.clone(),
        });
    }
    Ok(ExtractionPlan { fields })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Default-shaped export: pilot name (no separators), corp ticker in
    /// `[…]`, ship type in `(…)` — same layout `extract_actor`'s fallback
    /// hardcodes, so a plan built from it should extract identically.
    const DEFAULT_LAYOUT: &str = "
tabSetup:
- - 0
  - - - name
      - Default
shipLabelOrder:
- pilot name
- corporation
- alliance
- ship name
- ship type
- null
shipLabels:
- - null
  - - - post
      - ''
    - - pre
      - ''
    - - state
      - 0
    - - type
      - null
- - alliance
  - - - post
      - ''
    - - pre
      - ''
    - - state
      - 0
    - - type
      - alliance
- - corporation
  - - - post
      - ']'
    - - pre
      - '['
    - - state
      - 1
    - - type
      - corporation
- - pilot name
  - - - post
      - ''
    - - pre
      - ''
    - - state
      - 1
    - - type
      - pilot name
- - ship name
  - - - post
      - ''''
    - - pre
      - ''''
    - - state
      - 0
    - - type
      - ship name
- - ship type
  - - - post
      - ')'
    - - pre
      - '('
    - - state
      - 1
    - - type
      - ship type
";

    /// A Z-S-style export: ship type first (in `«…»`), then a `::` divider,
    /// then pilot name, then corp in `‹…›` — a genuinely different order and
    /// separator set from the default, to prove the plan (not a hardcoded
    /// shape) drives extraction.
    const ZS_LAYOUT: &str = "
shipLabelOrder:
- ship type
- pilot name
- corporation
- alliance
- ship name
- null
shipLabels:
- - null
  - - - post
      - ''
    - - pre
      - ''
    - - state
      - 0
    - - type
      - null
- - ship type
  - - - post
      - '» :: '
    - - pre
      - '«'
    - - state
      - 1
    - - type
      - ship type
- - pilot name
  - - - post
      - ' '
    - - pre
      - ''
    - - state
      - 1
    - - type
      - pilot name
- - corporation
  - - - post
      - '›'
    - - pre
      - '‹'
    - - state
      - 1
    - - type
      - corporation
- - alliance
  - - - post
      - ''
    - - pre
      - ''
    - - state
      - 0
    - - type
      - alliance
- - ship name
  - - - post
      - ''''
    - - pre
      - ''''
    - - state
      - 0
    - - type
      - ship name
";

    #[test]
    fn parses_default_layout_into_pilot_corp_ship_fields() {
        let plan = parse_overview_export(DEFAULT_LAYOUT).unwrap();
        let fields: Vec<_> = plan.fields.iter().map(|f| f.field).collect();
        assert_eq!(
            fields,
            vec![
                LabelField::PilotName,
                LabelField::Corporation,
                LabelField::ShipType,
            ]
        );
        let corp = &plan.fields[1];
        assert_eq!(corp.pre, "[");
        assert_eq!(corp.post, "]");
        let ship = &plan.fields[2];
        assert_eq!(ship.pre, "(");
        assert_eq!(ship.post, ")");
    }

    #[test]
    fn parses_custom_order_and_separators() {
        let plan = parse_overview_export(ZS_LAYOUT).unwrap();
        assert_eq!(plan.fields.len(), 3);
        assert_eq!(plan.fields[0].field, LabelField::ShipType);
        assert_eq!(plan.fields[0].pre, "«");
        assert_eq!(plan.fields[0].post, "» :: ");
        assert_eq!(plan.fields[1].field, LabelField::PilotName);
        assert_eq!(plan.fields[2].field, LabelField::Corporation);
        assert_eq!(plan.fields[2].pre, "‹");
        assert_eq!(plan.fields[2].post, "›");
    }

    #[test]
    fn rejects_a_file_that_is_not_an_overview_export() {
        assert!(parse_overview_export("just: some\nyaml: file\n").is_err());
        assert!(parse_overview_export("not yaml at all: [").is_err());
    }
}
