//! Shared breakdown row types for the DPS meter's fixed-grid aggregation
//! ([`super::bucket`]): per-weapon and per-pilot engagement rows plus the
//! hit-quality tally. The rolling-window aggregation (`Window`/`DpsTick`)
//! that originally lived here was deleted with the rewrite onto epoch-aligned
//! 5 s buckets (#982/#987) — buckets carry these same row shapes, so the UI
//! and the SDE enrichment never changed.

use serde::Serialize;

/// A weapon/ammo/drone damage row. `kind` is the source type (the ammo/drone's
/// SDE group, e.g. "Rocket", "Hybrid Charge", "Light Scout Drone"); `damage` is
/// the ammo's dominant damage type(s) (e.g. "Kin", "EM/Th"). Both are filled in
/// by the command layer from the SDE — the combat log names only the ammo, not
/// the weapon module or the damage type.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WeaponRate {
    pub name: String,
    pub dps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub damage: Option<String>,
}

/// Per-pilot engagement: damage you dealt to / took from this counterparty.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PilotRate {
    pub name: String,
    pub dps_out: f64,
    pub dps_in: f64,
    /// Ship the attacker is flying, parsed from `(SHIP)` in the combat log.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ship: Option<String>,
    /// Per-source damage you dealt to them (outgoing), each with its dps.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub weapons_out: Vec<WeaponRate>,
    /// Per-source damage they dealt to you (incoming; the source is named only
    /// for player attackers — EVE never names an NPC's weapon).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub weapons_in: Vec<WeaponRate>,
    /// Hit-quality tally of your hits on them.
    #[serde(default)]
    pub quality_out: HitQuality,
    /// Hit-quality tally of their hits on you.
    #[serde(default)]
    pub quality_in: HitQuality,
    /// Tackle you're applying to them within the bucket.
    #[serde(default)]
    pub scram_out: bool,
    #[serde(default)]
    pub point_out: bool,
    /// Tackle they're applying to you within the bucket.
    #[serde(default)]
    pub scram_in: bool,
    #[serde(default)]
    pub point_in: bool,
}

/// Counts of each hit-quality tier, worst→best: misses, glances off, grazes,
/// hits, penetrates, smashes, wrecks (from the gamelog's quality suffix;
/// misses come from the separate miss lines).
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HitQuality {
    pub misses: i64,
    pub glances: i64,
    pub grazes: i64,
    pub hits: i64,
    pub penetrates: i64,
    pub smashes: i64,
    pub wrecks: i64,
}

impl HitQuality {
    pub(crate) fn count(&mut self, quality: Option<&str>) {
        let Some(q) = quality else { return };
        if q.eq_ignore_ascii_case("misses") {
            self.misses += 1;
        } else if q.eq_ignore_ascii_case("glances off") {
            self.glances += 1;
        } else if q.eq_ignore_ascii_case("grazes") {
            self.grazes += 1;
        } else if q.eq_ignore_ascii_case("hits") {
            self.hits += 1;
        } else if q.eq_ignore_ascii_case("penetrates") {
            self.penetrates += 1;
        } else if q.eq_ignore_ascii_case("smashes") {
            self.smashes += 1;
        } else if q.eq_ignore_ascii_case("wrecks") {
            self.wrecks += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_quality_counts_each_tier_case_insensitively() {
        let mut q = HitQuality::default();
        q.count(Some("Misses"));
        q.count(Some("glances off"));
        q.count(Some("Grazes"));
        q.count(Some("HITS"));
        q.count(Some("Penetrates"));
        q.count(Some("Smashes"));
        q.count(Some("Wrecks"));
        q.count(Some("not a tier"));
        q.count(None);
        assert_eq!((q.misses, q.glances, q.grazes, q.hits), (1, 1, 1, 1));
        assert_eq!((q.penetrates, q.smashes, q.wrecks), (1, 1, 1));
    }
}
