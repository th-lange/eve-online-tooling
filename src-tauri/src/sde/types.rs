use serde::{Deserialize, Serialize};

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

/// Bulk-resolved type names for a set of ids, from one `type_names` query.
/// Unknown ids fall back to `Type <id>`, matching [`super::Sde::type_name_or_id`].
#[derive(Debug, Clone, Default)]
pub struct TypeNameMap(pub(super) std::collections::HashMap<i64, String>);

impl TypeNameMap {
    /// The resolved name for `id`, or `Type <id>` if it wasn't found.
    pub fn get(&self, id: i64) -> String {
        self.0
            .get(&id)
            .cloned()
            .unwrap_or_else(|| format!("Type {id}"))
    }
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

/// Full SDE metadata for one type (universe browser detail pane).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeDetail {
    pub type_id: i64,
    pub name: String,
    pub description: Option<String>,
    pub mass: Option<f64>,
    pub volume: Option<f64>,
    pub capacity: Option<f64>,
    pub portion_size: Option<i64>,
    pub market_group_id: Option<i64>,
    pub published: bool,
    pub base_price: Option<f64>,
}

/// What reprocessing/refining one item yields, per `portion_size` units.
#[derive(Debug, Clone)]
pub struct ReprocessRecipe {
    pub type_id: i64,
    pub name: String,
    /// Units consumed per refine cycle (`portionSize`); yields are per portion.
    pub portion_size: i64,
    /// Output materials and their per-portion base quantity (before efficiency).
    pub outputs: Vec<BlueprintMaterial>,
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

/// One wormhole type (`invTypes` group 988) with its physics, read from the SDE
/// dogma attributes — the offline "whtype.info" view. `dest_class_id` is 0 for
/// K162 (the generic exit signature, whose target class isn't fixed).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WormholeType {
    pub type_id: i64,
    /// Signature code, e.g. "K162", "N766".
    pub code: String,
    /// Destination wormhole class id (0 = K162 / variable exit).
    pub dest_class_id: i64,
    /// Human label for the destination class (e.g. "C4", "HS", "exit (variable)").
    pub dest_class_label: String,
    /// Total mass the hole can carry before collapse (kg).
    pub max_stable_mass: Option<f64>,
    /// Largest single ship that can jump it (kg).
    pub max_jump_mass: Option<f64>,
    /// Natural lifetime in minutes.
    pub max_stable_time_min: Option<f64>,
    /// Mass regenerated per cycle (kg).
    pub mass_regen: Option<f64>,
}

/// A planetary-interaction factory schematic: its cycle time and the P-level
/// inputs it consumes / outputs it produces (from `planetSchematics*`).
#[derive(Debug, Clone, PartialEq)]
pub struct PlanetSchematic {
    pub schematic_id: i64,
    pub name: String,
    /// Production cycle length in seconds.
    pub cycle_time: i64,
    /// `(type_id, quantity)` consumed per cycle.
    pub inputs: Vec<(i64, i64)>,
    /// `(type_id, quantity)` produced per cycle.
    pub outputs: Vec<(i64, i64)>,
}

// --- Fitting / dogma (#159, #160) ---

/// One parsed entry of a `dgmEffects.modifierInfo` JSON array — the SDE's
/// pre-parsed description of *how* an effect modifies an attribute. The fitting
/// engine turns these into its internal modifier representation; we keep the
/// SDE's own field names here. `dgmExpressions` is empty in the Fuzzwork dump,
/// so this is the only structured modifier source (see #157).
///
/// Example (Gyrostabilizer II, effect 92):
/// `{"domain":"shipID","func":"LocationGroupModifier","groupID":55,
///   "modifiedAttributeID":64,"modifyingAttributeID":64,"operation":4}`
// Consumed by the dogma engine (P2, #170/#171); landed here with the SDE query.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModifierInfo {
    /// `shipID` | `charID` | `itemID` | `targetID` | `otherID` (where the target lives).
    #[serde(default)]
    pub domain: Option<String>,
    /// `ItemModifier` | `LocationModifier` | `LocationGroupModifier` |
    /// `(Owner|Location)RequiredSkillModifier` | `EffectStopper` | …
    #[serde(default)]
    pub func: Option<String>,
    /// Attribute being changed on each target.
    #[serde(rename = "modifiedAttributeID", default)]
    pub modified_attribute_id: Option<i64>,
    /// Attribute on the affecting item carrying the magnitude.
    #[serde(rename = "modifyingAttributeID", default)]
    pub modifying_attribute_id: Option<i64>,
    /// EVE operation code: 0 preAssign, 1 preMul, 2 modAdd, 3 modSub,
    /// 4 postMul, 5 postPercent, 6 postDiv, 7 postAssign.
    #[serde(default)]
    pub operation: Option<i64>,
    /// For `LocationGroupModifier`: restrict targets to this group.
    #[serde(rename = "groupID", default)]
    pub group_id: Option<i64>,
    /// For skill modifiers: restrict to items requiring this skill.
    #[serde(rename = "skillTypeID", default)]
    pub skill_type_id: Option<i64>,
}

/// Metadata for one dogma effect (`dgmEffects`) plus its parsed modifiers.
#[allow(dead_code)] // consumed by the dogma engine (P2, #171)
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffectMeta {
    pub effect_id: i64,
    pub name: String,
    /// Effect category (1 passive, 2 online, 3 active, 4 overload, …).
    pub category: i64,
    pub is_offensive: bool,
    pub is_assistance: bool,
    /// Attribute ids describing an active effect's cycle, if any.
    pub duration_attribute_id: Option<i64>,
    pub discharge_attribute_id: Option<i64>,
    pub range_attribute_id: Option<i64>,
    pub falloff_attribute_id: Option<i64>,
    pub tracking_speed_attribute_id: Option<i64>,
    /// Parsed `modifierInfo` (empty when the effect carries none).
    pub modifiers: Vec<ModifierInfo>,
}

/// Metadata for one dogma attribute (`dgmAttributeTypes`).
#[allow(dead_code)] // consumed by the dogma engine's stacking logic (P2, #170)
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttrMeta {
    pub attribute_id: i64,
    pub default_value: f64,
    /// `stackable = 0` ⇒ multiplicative bonuses to this attribute are subject to
    /// the stacking penalty.
    pub stackable: bool,
    /// Whether a higher value is better (orients the stacking-penalty sort).
    pub high_is_good: bool,
}

/// A ship hull's slot layout and fitting resources, for the empty editor (#160).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShipLayout {
    pub type_id: i64,
    pub name: String,
    pub high_slots: i64,
    pub mid_slots: i64,
    pub low_slots: i64,
    pub rig_slots: i64,
    pub subsystem_slots: i64,
    pub turret_hardpoints: i64,
    pub launcher_hardpoints: i64,
    pub cpu_output: f64,
    pub powergrid_output: f64,
    pub calibration: f64,
    pub drone_bay: f64,
    pub drone_bandwidth: f64,
}

/// A solar system's identity plus the region it belongs to, for point
/// lookups (e.g. "where is this character right now?") that shouldn't pay
/// for a full-map load. `security` is the raw SDE float (−1.0 … 1.0).
#[derive(Debug, Clone)]
pub struct SystemInfo {
    pub name: String,
    pub security: f64,
    pub region_id: i64,
    pub region_name: String,
}
