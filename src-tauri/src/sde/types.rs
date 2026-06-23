use serde::Serialize;

/// Activity ids as used by the SDE `industryActivity*` tables.
pub mod activity {
    pub const MANUFACTURING: i64 = 1;
    /// Reserved for the invention/T2 work (issue #9).
    #[allow(dead_code)]
    pub const INVENTION: i64 = 8;
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

/// Invention (SDE activity 8) that produces a T2 blueprint.
#[derive(Debug, Clone, PartialEq)]
pub struct InventionData {
    /// The T1 blueprint that invents the T2 blueprint.
    pub inventing_blueprint_type_id: i64,
    /// Runs on the resulting T2 BPC per successful attempt.
    pub runs_per_success: i64,
    /// Base success probability (0..1), no decryptor.
    pub probability: f64,
    /// Datacores (and any other inputs) consumed per attempt.
    pub datacores: Vec<BlueprintMaterial>,
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
