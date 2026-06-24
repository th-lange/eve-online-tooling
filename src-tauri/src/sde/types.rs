use serde::Serialize;

/// Activity ids as used by the SDE `industryActivity*` tables.
pub mod activity {
    pub const MANUFACTURING: i64 = 1;
    pub const INVENTION: i64 = 8;
    pub const REACTION: i64 = 11;
}

/// How to build a product: a manufacturing blueprint or a reaction formula.
#[derive(Debug, Clone)]
pub struct Recipe {
    pub blueprint_type_id: i64,
    pub activity_id: i64,
    pub product_quantity: i64,
    pub materials: Vec<BlueprintMaterial>,
}

/// An item type from `invTypes` (+ its group).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TypeInfo {
    pub type_id: i64,
    pub name: String,
    pub group_id: i64,
    pub group_name: Option<String>,
    pub volume: Option<f64>,
}

/// One manufacturing input of a blueprint.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintMaterial {
    pub material_type_id: i64,
    pub name: String,
    /// Base quantity per single run (before ME).
    pub quantity: i64,
}

/// What a blueprint manufactures.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintProduct {
    pub product_type_id: i64,
    pub name: String,
    /// Units produced per run.
    pub quantity: i64,
}

/// An invention decryptor and its outcome modifiers (read from the SDE).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decryptor {
    pub type_id: i64,
    pub name: String,
    /// Multiplier on invention success probability.
    pub probability_multiplier: f64,
    /// Added to the invented T2 BPC's material efficiency.
    pub me_modifier: i64,
    /// Added to runs per successful invention.
    pub run_modifier: i64,
}

/// Invention (SDE activity 8) that produces a T2 or T3 blueprint.
#[derive(Debug, Clone, PartialEq)]
pub struct InventionData {
    /// The thing that does the inventing: a T1 blueprint (copied, for T2) or an
    /// Ancient Relic (consumed/bought, for T3 strategic cruisers & subsystems).
    pub inventing_blueprint_type_id: i64,
    /// Runs on the resulting T2/T3 BPC per successful attempt.
    pub runs_per_success: i64,
    /// Base success probability (0..1), no decryptor.
    pub probability: f64,
    /// Datacores (and any other inputs) consumed per attempt.
    pub datacores: Vec<BlueprintMaterial>,
    /// For T3 (relic) invention: the Ancient Relic consumed per attempt, which
    /// is bought at market (not copied). `None` for T2 (T1-BPC) invention.
    pub relic: Option<BlueprintMaterial>,
}

/// A tradeable market item (published, has a market group).
#[derive(Debug, Clone)]
pub struct MarketItem {
    pub type_id: i64,
    pub name: String,
    /// Packaged volume in m³ (for ISK/m³ in daytrading); `None` if unset.
    pub volume: Option<f64>,
}

/// A manufacturable blueprint, keyed for ranking/lookup.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManufacturableBlueprint {
    pub blueprint_type_id: i64,
    pub product_type_id: i64,
    pub product_name: String,
    pub product_quantity: i64,
}
