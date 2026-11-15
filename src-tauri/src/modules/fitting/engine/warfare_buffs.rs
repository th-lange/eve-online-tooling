//! Fleet warfare buffs (command bursts, expedition and mining bursts) — #1279.
//!
//! A command burst's behaviour isn't carried by dogma `modifierInfo`: the
//! module's `moduleBonusWarfareLink*` effect is empty, and the charge only
//! names *which* buff IDs it projects (`warfareBuff{1..4}ID`, attrs 2468 /
//! 2470 / 2472 / 2536) with what magnitude (`warfareBuff{1..4}Multiplier`,
//! attrs 2596–2599). What each buff ID *does* — which attribute of the
//! receiving ship or its modules it boosts, by how, and whether the boost is
//! stacking-penalised — is game-side knowledge that the SDE dump lacks. This
//! module holds it as data ([`applications`]); [`resolve`](super::resolve)
//! applies it right after the fit's own modifiers so a percentage acts on the
//! skill-modified value and penalised buffs join the attribute's normal
//! stacking chain.
//!
//! The per-ID behaviour table was derived from pyfa's command-burst handling
//! (<https://github.com/pyfa-org/Pyfa>, `Fit.__runCommandBoosts`) as the
//! reference for which attributes each buff touches; it is re-expressed here
//! as our own data, not copied code.
//!
//! Magnitudes from several sources are merged per buff ID — only the strongest
//! (largest `|value|`) applies, as in-game (a fleet member's duplicate burst
//! doesn't stack).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::modifier::Op;

// --- Attribute IDs (names verified against the SDE by a gated test) --------

const SHIELD_EM_RES: i64 = 271; // shieldEmDamageResonance
const SHIELD_EXP_RES: i64 = 272;
const SHIELD_KIN_RES: i64 = 273;
const SHIELD_THERM_RES: i64 = 274;
const ARMOR_EM_RES: i64 = 267; // armorEmDamageResonance
const ARMOR_EXP_RES: i64 = 268;
const ARMOR_KIN_RES: i64 = 269;
const ARMOR_THERM_RES: i64 = 270;
const CAPACITOR_NEED: i64 = 6;
const DURATION: i64 = 73;
const SHIELD_CAPACITY: i64 = 263;
const ARMOR_HP: i64 = 265;
const SCAN_RESOLUTION: i64 = 564;
const MAX_RANGE: i64 = 54;
const FALLOFF_EFFECTIVENESS: i64 = 2044;
const SCAN_MAG_STRENGTH_BONUS: i64 = 240; // scanMagnetometricStrengthBonus
const SCAN_RADAR_STRENGTH_BONUS: i64 = 241;
const SCAN_LADAR_STRENGTH_BONUS: i64 = 239;
const SCAN_GRAV_STRENGTH_BONUS: i64 = 238;
const MISSILE_VELOCITY_BONUS: i64 = 547;
const EXPLOSION_DELAY_BONUS: i64 = 596;
const AOE_VELOCITY_BONUS: i64 = 847;
const FALLOFF_BONUS: i64 = 349;
const MAX_RANGE_BONUS: i64 = 351;
const AOE_CLOUD_SIZE_BONUS: i64 = 848;
const TRACKING_SPEED_BONUS: i64 = 767;
const MAX_TARGET_RANGE_BONUS: i64 = 309;
const SCAN_RESOLUTION_BONUS: i64 = 566;
const SIGNATURE_RADIUS_BONUS: i64 = 554;
const SCAN_GRAV_STRENGTH: i64 = 211; // scanGravimetricStrength
const SCAN_RADAR_STRENGTH: i64 = 208;
const SCAN_LADAR_STRENGTH: i64 = 209;
const SCAN_MAG_STRENGTH: i64 = 210;
const SENSOR_DAMP_RESISTANCE: i64 = 2112;
const WEAPON_DISRUPT_RESISTANCE: i64 = 2113;
const SIGNATURE_RADIUS: i64 = 552;
const SPEED_FACTOR: i64 = 20;
const CRYSTAL_VOLATILITY_CHANCE: i64 = 783;
const MAX_TARGET_RANGE: i64 = 76;
const AGILITY: i64 = 70;
const PROBE_STRENGTH_BONUS: i64 = 6118; // expeditionCommandBurstProbeStrengthBonusCharID
const PROBE_DEVIATION_BONUS: i64 = 6119; // expeditionCommandBurstProbeDeviationBonusCharID
const MAX_DIRECTIONAL_SCAN_RANGE: i64 = 5796;
const VIRUS_COHERENCE: i64 = 1909;
const MINING_CRIT_CHANCE: i64 = 5967;
const MINING_WASTE_PROBABILITY: i64 = 3154;

// --- Skill / group type IDs ------------------------------------------------

const SHIELD_OPERATION: i64 = 3416;
const SHIELD_EMISSION_SYSTEMS: i64 = 3422;
const CAP_SHIELD_EMISSION_SYSTEMS: i64 = 24571;
const REMOTE_ARMOR_REPAIR_SYSTEMS: i64 = 16069;
const REPAIR_SYSTEMS: i64 = 3393;
const CAP_REMOTE_ARMOR_REPAIR_SYSTEMS: i64 = 24568;
const AFTERBURNER: i64 = 3450;
const HIGH_SPEED_MANEUVERING: i64 = 3454;
const MINING: i64 = 3386;
const ICE_HARVESTING: i64 = 16281;
const GAS_CLOUD_HARVESTING: i64 = 25544;
const ASTROMETRICS: i64 = 3412;
const SALVAGING: i64 = 25863;

const GROUP_ECM: i64 = 201;
const GROUP_SENSOR_DAMPENER: i64 = 208;
const GROUP_WEAPON_DISRUPTOR: i64 = 291;
const GROUP_TARGET_PAINTER: i64 = 379;
const GROUP_STASIS_WEB: i64 = 65;
const GROUP_WARP_SCRAMBLER: i64 = 52;
const GROUP_DATA_MINER: i64 = 538;
const GROUP_SALVAGER: i64 = 1122;

/// Which entities of the receiving fit a buff application reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// The hull.
    Ship,
    /// Fitted modules requiring any of these skills.
    ModulesSkill(&'static [i64]),
    /// Fitted modules in any of these groups.
    ModulesGroup(&'static [i64]),
    /// Fitted modules whose *loaded charge* requires this skill (the buff
    /// modifies the module, not the charge — e.g. scan-probe launchers).
    ModulesChargeSkill(i64),
    /// Loaded charges requiring this skill.
    ChargesSkill(i64),
}

/// One attribute change a buff makes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Application {
    pub target: Target,
    pub attr: i64,
    /// [`Op::PostPercent`] (`attr *= 1 + v/100`) or [`Op::ModAdd`] (`attr += v`).
    pub op: Op,
    /// Joins the attribute's stacking-penalty chain (when the attribute is
    /// itself non-stackable in the SDE, like every other module bonus).
    pub penalized: bool,
}

const fn pct(target: Target, attr: i64, penalized: bool) -> Application {
    Application {
        target,
        attr,
        op: Op::PostPercent,
        penalized,
    }
}

const SHIELD_OPS_SKILLS: &[i64] = &[
    SHIELD_OPERATION,
    SHIELD_EMISSION_SYSTEMS,
    CAP_SHIELD_EMISSION_SYSTEMS,
];
const ARMOR_REP_SKILLS: &[i64] = &[
    REMOTE_ARMOR_REPAIR_SYSTEMS,
    REPAIR_SYSTEMS,
    CAP_REMOTE_ARMOR_REPAIR_SYSTEMS,
];
const EWAR_GROUPS: &[i64] = &[
    GROUP_ECM,
    GROUP_SENSOR_DAMPENER,
    GROUP_WEAPON_DISRUPTOR,
    GROUP_TARGET_PAINTER,
];
const ECM_GROUP: &[i64] = &[GROUP_ECM];
const DISRUPTOR_GROUP: &[i64] = &[GROUP_WEAPON_DISRUPTOR];
const DAMP_GROUP: &[i64] = &[GROUP_SENSOR_DAMPENER];
const PAINTER_GROUP: &[i64] = &[GROUP_TARGET_PAINTER];
const TACKLE_GROUPS: &[i64] = &[GROUP_STASIS_WEB, GROUP_WARP_SCRAMBLER];
const PROP_SKILLS: &[i64] = &[AFTERBURNER, HIGH_SPEED_MANEUVERING];
const MINING_SKILLS: &[i64] = &[MINING, ICE_HARVESTING, GAS_CLOUD_HARVESTING];
const ORE_ICE_SKILLS: &[i64] = &[MINING, ICE_HARVESTING];
const HACK_SALV_GROUPS: &[i64] = &[GROUP_DATA_MINER, GROUP_SALVAGER];
const DATA_MINER_GROUP: &[i64] = &[GROUP_DATA_MINER];
const SALVAGING_SKILL: &[i64] = &[SALVAGING];

/// One buff ID: its display names, the charge multiplier it ships with (the
/// base of the generic-link presets) and what it changes.
struct BuffDef {
    id: i64,
    /// The burst charge it belongs to, e.g. "Evasive Maneuvers".
    link: &'static str,
    /// What it changes, e.g. "signature radius".
    effect: &'static str,
    /// `warfareBuffNMultiplier` on the burst charge that carries this buff
    /// (SDE-verified by a gated test).
    base: f64,
    apps: &'static [Application],
}

const SHIP: Target = Target::Ship;

static BUFFS: &[BuffDef] = &[
    BuffDef {
        id: 10,
        link: "Shield Harmonizing",
        effect: "shield resistances",
        base: -8.0,
        apps: &[
            pct(SHIP, SHIELD_EM_RES, true),
            pct(SHIP, SHIELD_EXP_RES, true),
            pct(SHIP, SHIELD_KIN_RES, true),
            pct(SHIP, SHIELD_THERM_RES, true),
        ],
    },
    BuffDef {
        id: 11,
        link: "Active Shielding",
        effect: "shield repair cycle & cap use",
        base: -8.0,
        apps: &[
            pct(
                Target::ModulesSkill(SHIELD_OPS_SKILLS),
                CAPACITOR_NEED,
                false,
            ),
            pct(Target::ModulesSkill(SHIELD_OPS_SKILLS), DURATION, false),
        ],
    },
    BuffDef {
        id: 12,
        link: "Shield Extension",
        effect: "shield HP",
        base: 8.0,
        apps: &[pct(SHIP, SHIELD_CAPACITY, false)],
    },
    BuffDef {
        id: 13,
        link: "Armor Energizing",
        effect: "armor resistances",
        base: -8.0,
        apps: &[
            pct(SHIP, ARMOR_EM_RES, true),
            pct(SHIP, ARMOR_THERM_RES, true),
            pct(SHIP, ARMOR_EXP_RES, true),
            pct(SHIP, ARMOR_KIN_RES, true),
        ],
    },
    BuffDef {
        id: 14,
        link: "Rapid Repair",
        effect: "armor repair cycle & cap use",
        base: -8.0,
        apps: &[
            pct(
                Target::ModulesSkill(ARMOR_REP_SKILLS),
                CAPACITOR_NEED,
                false,
            ),
            pct(Target::ModulesSkill(ARMOR_REP_SKILLS), DURATION, false),
        ],
    },
    BuffDef {
        id: 15,
        link: "Armor Reinforcement",
        effect: "armor HP",
        base: 8.0,
        apps: &[pct(SHIP, ARMOR_HP, false)],
    },
    BuffDef {
        id: 16,
        link: "Sensor Optimization",
        effect: "scan resolution",
        base: 9.0,
        apps: &[pct(SHIP, SCAN_RESOLUTION, true)],
    },
    BuffDef {
        id: 17,
        link: "Electronic Superiority",
        effect: "EWAR range & strength",
        base: 9.0,
        apps: &[
            pct(Target::ModulesGroup(EWAR_GROUPS), MAX_RANGE, true),
            pct(
                Target::ModulesGroup(EWAR_GROUPS),
                FALLOFF_EFFECTIVENESS,
                true,
            ),
            pct(
                Target::ModulesGroup(ECM_GROUP),
                SCAN_GRAV_STRENGTH_BONUS,
                true,
            ),
            pct(
                Target::ModulesGroup(ECM_GROUP),
                SCAN_RADAR_STRENGTH_BONUS,
                true,
            ),
            pct(
                Target::ModulesGroup(ECM_GROUP),
                SCAN_LADAR_STRENGTH_BONUS,
                true,
            ),
            pct(
                Target::ModulesGroup(ECM_GROUP),
                SCAN_MAG_STRENGTH_BONUS,
                true,
            ),
            pct(
                Target::ModulesGroup(DISRUPTOR_GROUP),
                MISSILE_VELOCITY_BONUS,
                false,
            ),
            pct(
                Target::ModulesGroup(DISRUPTOR_GROUP),
                EXPLOSION_DELAY_BONUS,
                false,
            ),
            pct(
                Target::ModulesGroup(DISRUPTOR_GROUP),
                AOE_VELOCITY_BONUS,
                false,
            ),
            pct(Target::ModulesGroup(DISRUPTOR_GROUP), FALLOFF_BONUS, false),
            pct(
                Target::ModulesGroup(DISRUPTOR_GROUP),
                MAX_RANGE_BONUS,
                false,
            ),
            pct(
                Target::ModulesGroup(DISRUPTOR_GROUP),
                AOE_CLOUD_SIZE_BONUS,
                false,
            ),
            pct(
                Target::ModulesGroup(DISRUPTOR_GROUP),
                TRACKING_SPEED_BONUS,
                false,
            ),
            pct(
                Target::ModulesGroup(DAMP_GROUP),
                MAX_TARGET_RANGE_BONUS,
                false,
            ),
            pct(
                Target::ModulesGroup(DAMP_GROUP),
                SCAN_RESOLUTION_BONUS,
                false,
            ),
            pct(
                Target::ModulesGroup(PAINTER_GROUP),
                SIGNATURE_RADIUS_BONUS,
                true,
            ),
        ],
    },
    BuffDef {
        id: 18,
        link: "Electronic Hardening",
        effect: "sensor strength",
        base: 18.0,
        apps: &[
            pct(SHIP, SCAN_GRAV_STRENGTH, true),
            pct(SHIP, SCAN_RADAR_STRENGTH, true),
            pct(SHIP, SCAN_LADAR_STRENGTH, true),
            pct(SHIP, SCAN_MAG_STRENGTH, true),
        ],
    },
    BuffDef {
        id: 19,
        link: "Electronic Hardening",
        effect: "damp/disruptor resistance",
        base: -9.0,
        apps: &[
            pct(SHIP, SENSOR_DAMP_RESISTANCE, false),
            pct(SHIP, WEAPON_DISRUPT_RESISTANCE, false),
        ],
    },
    BuffDef {
        id: 20,
        link: "Evasive Maneuvers",
        effect: "signature radius",
        base: -6.0,
        apps: &[pct(SHIP, SIGNATURE_RADIUS, true)],
    },
    BuffDef {
        id: 21,
        link: "Interdiction Maneuvers",
        effect: "tackle range",
        base: 12.0,
        apps: &[pct(Target::ModulesGroup(TACKLE_GROUPS), MAX_RANGE, true)],
    },
    BuffDef {
        id: 22,
        link: "Rapid Deployment",
        effect: "AB/MWD speed boost",
        base: 12.0,
        apps: &[pct(Target::ModulesSkill(PROP_SKILLS), SPEED_FACTOR, true)],
    },
    BuffDef {
        id: 23,
        link: "Mining Laser Field Enhancement",
        effect: "mining range",
        base: 40.0,
        apps: &[pct(Target::ModulesSkill(MINING_SKILLS), MAX_RANGE, true)],
    },
    BuffDef {
        id: 24,
        link: "Mining Laser Optimization",
        effect: "mining cycle & cap use",
        base: -15.0,
        apps: &[
            pct(Target::ModulesSkill(MINING_SKILLS), CAPACITOR_NEED, true),
            pct(Target::ModulesSkill(MINING_SKILLS), DURATION, true),
        ],
    },
    BuffDef {
        id: 25,
        link: "Mining Equipment Preservation",
        effect: "crystal volatility",
        base: -15.0,
        apps: &[pct(
            Target::ChargesSkill(MINING),
            CRYSTAL_VOLATILITY_CHANCE,
            true,
        )],
    },
    BuffDef {
        id: 26,
        link: "Sensor Optimization",
        effect: "targeting range",
        base: 18.0,
        apps: &[pct(SHIP, MAX_TARGET_RANGE, true)],
    },
    BuffDef {
        id: 60,
        link: "Evasive Maneuvers",
        effect: "agility",
        base: -6.0,
        apps: &[pct(SHIP, AGILITY, true)],
    },
    BuffDef {
        id: 2464,
        link: "Expedition Strength",
        effect: "probe strength",
        base: 8.0,
        apps: &[pct(
            Target::ModulesChargeSkill(ASTROMETRICS),
            PROBE_STRENGTH_BONUS,
            true,
        )],
    },
    BuffDef {
        id: 2465,
        link: "Expedition Reach",
        effect: "d-scan, hacking & salvager range",
        base: 20.0,
        apps: &[
            pct(SHIP, MAX_DIRECTIONAL_SCAN_RANGE, false),
            pct(Target::ModulesGroup(HACK_SALV_GROUPS), MAX_RANGE, true),
        ],
    },
    BuffDef {
        id: 2466,
        link: "Expedition Pinpointing",
        effect: "scan deviation",
        base: -8.0,
        apps: &[pct(
            Target::ModulesChargeSkill(ASTROMETRICS),
            PROBE_DEVIATION_BONUS,
            true,
        )],
    },
    BuffDef {
        id: 2468,
        link: "Expedition Strength",
        effect: "virus coherence",
        base: 8.0,
        apps: &[Application {
            target: Target::ModulesGroup(DATA_MINER_GROUP),
            attr: VIRUS_COHERENCE,
            op: Op::ModAdd,
            penalized: false,
        }],
    },
    BuffDef {
        id: 2481,
        link: "Expedition Pinpointing",
        effect: "salvager cycle time",
        base: -8.0,
        apps: &[pct(Target::ModulesSkill(SALVAGING_SKILL), DURATION, false)],
    },
    BuffDef {
        id: 2516,
        link: "Mining Laser Efficiency",
        effect: "mining crit chance",
        base: 50.0,
        apps: &[pct(
            Target::ModulesSkill(ORE_ICE_SKILLS),
            MINING_CRIT_CHANCE,
            false,
        )],
    },
    BuffDef {
        id: 2517,
        link: "Mining Laser Efficiency",
        effect: "mining residue chance",
        base: -15.0,
        apps: &[pct(
            Target::ModulesSkill(MINING_SKILLS),
            MINING_WASTE_PROBABILITY,
            true,
        )],
    },
];

fn def(buff_id: i64) -> Option<&'static BuffDef> {
    BUFFS.iter().find(|b| b.id == buff_id)
}

/// What a buff ID changes on the receiving fit (empty for unknown IDs).
pub fn applications(buff_id: i64) -> &'static [Application] {
    def(buff_id).map_or(&[], |d| d.apps)
}

/// Display label of a buff ID, e.g. "Evasive Maneuvers: signature radius".
pub fn label(buff_id: i64) -> String {
    def(buff_id).map_or_else(
        || format!("Buff {buff_id}"),
        |d| format!("{}: {}", d.link, d.effect),
    )
}

/// Every command-burst link a user can pick as a generic link (#1279): the
/// charge, or an "All" of a family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkType {
    ShieldHarmonizing,
    ShieldActiveShielding,
    ShieldExtension,
    ShieldAll,
    ArmorEnergizing,
    ArmorRapidRepair,
    ArmorReinforcement,
    ArmorAll,
    SkirmishEvasiveManeuvers,
    SkirmishInterdictionManeuvers,
    SkirmishRapidDeployment,
    SkirmishAll,
    InformationSensorOptimization,
    InformationElectronicSuperiority,
    InformationElectronicHardening,
    InformationAll,
    ExpeditionStrength,
    ExpeditionReach,
    ExpeditionPinpointing,
    ExpeditionAll,
    MiningFieldEnhancement,
    MiningOptimization,
    MiningPreservation,
    MiningEfficiency,
    MiningAll,
}

impl LinkType {
    /// The buff IDs this link projects.
    pub fn buff_ids(self) -> &'static [i64] {
        use LinkType::*;
        match self {
            ShieldHarmonizing => &[10],
            ShieldActiveShielding => &[11],
            ShieldExtension => &[12],
            ShieldAll => &[10, 11, 12],
            ArmorEnergizing => &[13],
            ArmorRapidRepair => &[14],
            ArmorReinforcement => &[15],
            ArmorAll => &[13, 14, 15],
            SkirmishEvasiveManeuvers => &[20, 60],
            SkirmishInterdictionManeuvers => &[21],
            SkirmishRapidDeployment => &[22],
            SkirmishAll => &[20, 60, 21, 22],
            InformationSensorOptimization => &[16, 26],
            InformationElectronicSuperiority => &[17],
            InformationElectronicHardening => &[18, 19],
            InformationAll => &[16, 26, 17, 18, 19],
            ExpeditionStrength => &[2464, 2468],
            ExpeditionReach => &[2465],
            ExpeditionPinpointing => &[2466, 2481],
            ExpeditionAll => &[2464, 2468, 2465, 2466, 2481],
            MiningFieldEnhancement => &[23],
            MiningOptimization => &[24],
            MiningPreservation => &[25],
            MiningEfficiency => &[2516, 2517],
            MiningAll => &[23, 24, 25, 2516, 2517],
        }
    }
}

/// A fleet boost the fit is "receiving" (#1279).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FleetBoost {
    /// A booster described only by its link and bonuses, valued by pyfa's
    /// generic-link formula (T2 module, all-V Command skills).
    GenericLink {
        link_type: LinkType,
        /// Command-ship/T3 hull bonus, % per level at V (0 = none, typically 2–5).
        #[serde(default)]
        strength_pct: f64,
        #[serde(default)]
        mindlink: bool,
    },
    /// A concrete burst module + charge, valued from its SDE attributes
    /// (booster skills assumed at V).
    Module {
        module_type_id: i64,
        #[serde(default)]
        charge_type_id: Option<i64>,
        #[serde(default)]
        strength_pct: f64,
        #[serde(default)]
        mindlink: bool,
    },
}

impl FleetBoost {
    /// Type IDs whose SDE attributes [`Self::values`] needs.
    pub fn type_ids(&self) -> impl Iterator<Item = i64> {
        match self {
            FleetBoost::GenericLink { .. } => [None, None],
            FleetBoost::Module {
                module_type_id,
                charge_type_id,
                ..
            } => [Some(*module_type_id), charge_type_id.filter(|c| *c > 0)],
        }
        .into_iter()
        .flatten()
    }

    /// The `(buff_id, value)` pairs this boost projects. `attrs_of` yields a
    /// type's base attributes (only consulted for [`FleetBoost::Module`]).
    pub fn values<'a>(
        &self,
        attrs_of: &impl Fn(i64) -> Option<&'a [(i64, f64)]>,
    ) -> Vec<(i64, f64)> {
        match self {
            FleetBoost::GenericLink {
                link_type,
                strength_pct,
                mindlink,
            } => link_type
                .buff_ids()
                .iter()
                .filter_map(|&id| {
                    let base = def(id)?.base;
                    Some((id, generic_value(base, *strength_pct, *mindlink)))
                })
                .collect(),
            FleetBoost::Module {
                module_type_id,
                charge_type_id,
                strength_pct,
                mindlink,
            } => {
                let (Some(module), Some(charge)) = (
                    attrs_of(*module_type_id),
                    charge_type_id.filter(|c| *c > 0).and_then(attrs_of),
                ) else {
                    return Vec::new();
                };
                module_pick_values(module, charge, *strength_pct, *mindlink)
            }
        }
    }
}

/// Booster's skills: Command Burst Specialist/Leadership at V = +50%.
const BOOSTER_SKILLS: f64 = 1.5;
/// A T2 burst module's `warfareBuffNValue`.
const T2_MODULE: f64 = 1.25;
const MINDLINK: f64 = 1.25;

fn hull_bonus(strength_pct: f64) -> f64 {
    1.0 + strength_pct.clamp(0.0, 5.0) * 5.0 / 100.0
}

/// pyfa's generic-link value: `base × 1.5 (skills V) × 1.25 (T2) ×
/// (1 + strength%×5/100) × (1.25 if mindlink)`.
pub fn generic_value(base: f64, strength_pct: f64, mindlink: bool) -> f64 {
    base * BOOSTER_SKILLS
        * T2_MODULE
        * hull_bonus(strength_pct)
        * if mindlink { MINDLINK } else { 1.0 }
}

/// `(warfareBuffNID, warfareBuffNMultiplier, warfareBuffNValue)` attribute IDs.
const SLOTS: [(i64, i64, i64); 4] = [
    (2468, 2596, 2469),
    (2470, 2597, 2471),
    (2472, 2598, 2473),
    (2536, 2599, 2537),
];

/// Values for a concrete burst module + charge: per slot,
/// `module.warfareBuffNValue × charge.warfareBuffNMultiplier` (the charge's
/// `chargeBonusWarfareCharge` effect) × booster skills V × hull bonus ×
/// mindlink.
fn module_pick_values(
    module: &[(i64, f64)],
    charge: &[(i64, f64)],
    strength_pct: f64,
    mindlink: bool,
) -> Vec<(i64, f64)> {
    let get = |attrs: &[(i64, f64)], id: i64| attrs.iter().find(|(k, _)| *k == id).map(|(_, v)| *v);
    SLOTS
        .iter()
        .filter_map(|&(id_attr, mult_attr, value_attr)| {
            let id = get(charge, id_attr)? as i64;
            let mult = get(charge, mult_attr)?;
            if id <= 0 {
                return None;
            }
            let module_value = get(module, value_attr).unwrap_or(1.0);
            Some((
                id,
                module_value
                    * mult
                    * BOOSTER_SKILLS
                    * hull_bonus(strength_pct)
                    * if mindlink { MINDLINK } else { 1.0 },
            ))
        })
        .collect()
}

/// Merge every source: per buff ID only the strongest `|value|` applies.
/// Unknown buff IDs and zero values are dropped. Sorted by buff ID.
pub fn merge(values: impl IntoIterator<Item = (i64, f64)>) -> Vec<(i64, f64)> {
    let mut best: BTreeMap<i64, f64> = BTreeMap::new();
    for (id, v) in values {
        if v == 0.0 || def(id).is_none() {
            continue;
        }
        let e = best.entry(id).or_insert(v);
        if v.abs() > e.abs() {
            *e = v;
        }
    }
    best.into_iter().collect()
}

/// A buff that ended up applied after the merge — shown in the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedBuff {
    pub buff_id: i64,
    pub label: String,
    /// Effective magnitude (percent for boosts; raw points for virus coherence).
    pub value_pct: f64,
}

pub fn applied(merged: &[(i64, f64)]) -> Vec<AppliedBuff> {
    merged
        .iter()
        .map(|&(buff_id, value_pct)| AppliedBuff {
            buff_id,
            label: label(buff_id),
            value_pct,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(l: LinkType, strength: f64, mind: bool) -> Vec<(i64, f64)> {
        FleetBoost::GenericLink {
            link_type: l,
            strength_pct: strength,
            mindlink: mind,
        }
        .values(&|_| None)
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn evasive_maneuvers_matches_pyfa_formula() {
        let v = link(LinkType::SkirmishEvasiveManeuvers, 0.0, false);
        assert_eq!(v.len(), 2);
        for (_, x) in &v {
            assert!(close(*x, -6.0 * 1.5 * 1.25), "{x}"); // -11.25
        }
        let v = link(LinkType::SkirmishEvasiveManeuvers, 5.0, true);
        for (_, x) in &v {
            assert!(close(*x, -6.0 * 1.5 * 1.25 * 1.25 * 1.25), "{x}"); // -17.578125
        }
    }

    /// Every preset yields each of its buff IDs once, at `base × 1.5 × 1.25`
    /// (strength 0, no mindlink).
    #[test]
    fn every_link_preset_produces_pyfa_values() {
        let expect: &[(LinkType, &[(i64, f64)])] = &[
            (LinkType::ShieldHarmonizing, &[(10, -8.0)]),
            (LinkType::ShieldActiveShielding, &[(11, -8.0)]),
            (LinkType::ShieldExtension, &[(12, 8.0)]),
            (LinkType::ShieldAll, &[(10, -8.0), (11, -8.0), (12, 8.0)]),
            (LinkType::ArmorEnergizing, &[(13, -8.0)]),
            (LinkType::ArmorRapidRepair, &[(14, -8.0)]),
            (LinkType::ArmorReinforcement, &[(15, 8.0)]),
            (LinkType::ArmorAll, &[(13, -8.0), (14, -8.0), (15, 8.0)]),
            (
                LinkType::SkirmishEvasiveManeuvers,
                &[(20, -6.0), (60, -6.0)],
            ),
            (LinkType::SkirmishInterdictionManeuvers, &[(21, 12.0)]),
            (LinkType::SkirmishRapidDeployment, &[(22, 12.0)]),
            (
                LinkType::SkirmishAll,
                &[(20, -6.0), (60, -6.0), (21, 12.0), (22, 12.0)],
            ),
            (
                LinkType::InformationSensorOptimization,
                &[(16, 9.0), (26, 18.0)],
            ),
            (LinkType::InformationElectronicSuperiority, &[(17, 9.0)]),
            (
                LinkType::InformationElectronicHardening,
                &[(18, 18.0), (19, -9.0)],
            ),
            (
                LinkType::InformationAll,
                &[(16, 9.0), (26, 18.0), (17, 9.0), (18, 18.0), (19, -9.0)],
            ),
            (LinkType::ExpeditionStrength, &[(2464, 8.0), (2468, 8.0)]),
            (LinkType::ExpeditionReach, &[(2465, 20.0)]),
            (
                LinkType::ExpeditionPinpointing,
                &[(2466, -8.0), (2481, -8.0)],
            ),
            (
                LinkType::ExpeditionAll,
                &[
                    (2464, 8.0),
                    (2468, 8.0),
                    (2465, 20.0),
                    (2466, -8.0),
                    (2481, -8.0),
                ],
            ),
            (LinkType::MiningFieldEnhancement, &[(23, 40.0)]),
            (LinkType::MiningOptimization, &[(24, -15.0)]),
            (LinkType::MiningPreservation, &[(25, -15.0)]),
            (LinkType::MiningEfficiency, &[(2516, 50.0), (2517, -15.0)]),
            (
                LinkType::MiningAll,
                &[
                    (23, 40.0),
                    (24, -15.0),
                    (25, -15.0),
                    (2516, 50.0),
                    (2517, -15.0),
                ],
            ),
        ];
        for (l, want) in expect {
            let got = link(*l, 0.0, false);
            assert_eq!(got.len(), want.len(), "{l:?}");
            for ((gi, gv), (wi, wv)) in got.iter().zip(*want) {
                assert_eq!(gi, wi, "{l:?}");
                assert!(close(*gv, wv * 1.5 * 1.25), "{l:?} {gi}: {gv}");
            }
        }
    }

    #[test]
    fn strongest_source_wins_per_buff() {
        let merged = merge([(20, -6.0), (20, -11.25), (20, -3.0), (22, 12.0), (22, 18.0)]);
        assert_eq!(merged, vec![(20, -11.25), (22, 18.0)]);
        // Sign is preserved: a bigger penalty beats a smaller bonus.
        assert_eq!(merge([(22, 5.0), (22, -9.0)]), vec![(22, -9.0)]);
        // Unknown IDs / zeros are dropped.
        assert!(merge([(9999, 5.0), (20, 0.0)]).is_empty());
    }

    #[test]
    fn module_pick_uses_module_value_charge_multiplier_and_skills() {
        // T2 burst (1.25) + Evasive Maneuvers charge (20×-6, 60×-6).
        let module = [(2469, 1.25), (2471, 1.25), (2473, 1.25), (2537, 1.25)];
        let charge = [
            (2468, 20.0),
            (2596, -6.0),
            (2470, 60.0),
            (2597, -6.0),
            (2472, 0.0),
            (2598, 0.0),
        ];
        let boost = FleetBoost::Module {
            module_type_id: 1,
            charge_type_id: Some(2),
            strength_pct: 0.0,
            mindlink: false,
        };
        let attrs_of = |id: i64| match id {
            1 => Some(&module[..]),
            2 => Some(&charge[..]),
            _ => None,
        };
        let v = boost.values(&attrs_of);
        assert_eq!(v.len(), 2);
        assert!(close(v[0].1, 1.25 * -6.0 * 1.5)); // -11.25
                                                   // No charge → nothing.
        let no_charge = FleetBoost::Module {
            module_type_id: 1,
            charge_type_id: None,
            strength_pct: 0.0,
            mindlink: false,
        };
        assert!(no_charge.values(&attrs_of).is_empty());
    }

    #[test]
    fn boost_json_shape() {
        let b: FleetBoost = serde_json::from_str(
            r#"{"kind":"genericLink","linkType":"skirmishRapidDeployment","strengthPct":5,"mindlink":true}"#,
        )
        .unwrap();
        assert_eq!(
            b,
            FleetBoost::GenericLink {
                link_type: LinkType::SkirmishRapidDeployment,
                strength_pct: 5.0,
                mindlink: true
            }
        );
        let m: FleetBoost =
            serde_json::from_str(r#"{"kind":"module","moduleTypeId":7,"chargeTypeId":9}"#).unwrap();
        assert_eq!(
            m,
            FleetBoost::Module {
                module_type_id: 7,
                charge_type_id: Some(9),
                strength_pct: 0.0,
                mindlink: false
            }
        );
    }

    /// Attribute/skill/group IDs hard-coded above are the names pyfa's table
    /// refers to, and each buff's `base` is the multiplier the SDE burst
    /// charges actually carry. Needs `EVE_SDE_PATH`.
    #[test]
    fn ids_and_bases_match_the_sde() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            eprintln!("ids_and_bases_match_the_sde: EVE_SDE_PATH unset — skipping");
            return;
        };
        if !std::path::Path::new(&path).exists() {
            return;
        }
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let attr_name = |id: i64| -> String {
            conn.query_row(
                "SELECT attributeName FROM dgmAttributeTypes WHERE attributeID=?",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        let type_name = |id: i64| -> String {
            conn.query_row("SELECT typeName FROM invTypes WHERE typeID=?", [id], |r| {
                r.get(0)
            })
            .unwrap()
        };
        let group_name = |id: i64| -> String {
            conn.query_row(
                "SELECT groupName FROM invGroups WHERE groupID=?",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        for (id, name) in [
            (SHIELD_EM_RES, "shieldEmDamageResonance"),
            (SHIELD_EXP_RES, "shieldExplosiveDamageResonance"),
            (SHIELD_KIN_RES, "shieldKineticDamageResonance"),
            (SHIELD_THERM_RES, "shieldThermalDamageResonance"),
            (ARMOR_EM_RES, "armorEmDamageResonance"),
            (ARMOR_EXP_RES, "armorExplosiveDamageResonance"),
            (ARMOR_KIN_RES, "armorKineticDamageResonance"),
            (ARMOR_THERM_RES, "armorThermalDamageResonance"),
            (CAPACITOR_NEED, "capacitorNeed"),
            (DURATION, "duration"),
            (SHIELD_CAPACITY, "shieldCapacity"),
            (ARMOR_HP, "armorHP"),
            (SCAN_RESOLUTION, "scanResolution"),
            (MAX_RANGE, "maxRange"),
            (FALLOFF_EFFECTIVENESS, "falloffEffectiveness"),
            (SCAN_MAG_STRENGTH_BONUS, "scanMagnetometricStrengthBonus"),
            (SCAN_RADAR_STRENGTH_BONUS, "scanRadarStrengthBonus"),
            (SCAN_LADAR_STRENGTH_BONUS, "scanLadarStrengthBonus"),
            (SCAN_GRAV_STRENGTH_BONUS, "scanGravimetricStrengthBonus"),
            (MISSILE_VELOCITY_BONUS, "missileVelocityBonus"),
            (EXPLOSION_DELAY_BONUS, "explosionDelayBonus"),
            (AOE_VELOCITY_BONUS, "aoeVelocityBonus"),
            (FALLOFF_BONUS, "falloffBonus"),
            (MAX_RANGE_BONUS, "maxRangeBonus"),
            (AOE_CLOUD_SIZE_BONUS, "aoeCloudSizeBonus"),
            (TRACKING_SPEED_BONUS, "trackingSpeedBonus"),
            (MAX_TARGET_RANGE_BONUS, "maxTargetRangeBonus"),
            (SCAN_RESOLUTION_BONUS, "scanResolutionBonus"),
            (SIGNATURE_RADIUS_BONUS, "signatureRadiusBonus"),
            (SCAN_GRAV_STRENGTH, "scanGravimetricStrength"),
            (SCAN_RADAR_STRENGTH, "scanRadarStrength"),
            (SCAN_LADAR_STRENGTH, "scanLadarStrength"),
            (SCAN_MAG_STRENGTH, "scanMagnetometricStrength"),
            (SENSOR_DAMP_RESISTANCE, "sensorDampenerResistance"),
            (WEAPON_DISRUPT_RESISTANCE, "weaponDisruptionResistance"),
            (SIGNATURE_RADIUS, "signatureRadius"),
            (SPEED_FACTOR, "speedFactor"),
            (CRYSTAL_VOLATILITY_CHANCE, "crystalVolatilityChance"),
            (MAX_TARGET_RANGE, "maxTargetRange"),
            (AGILITY, "agility"),
            (
                PROBE_STRENGTH_BONUS,
                "expeditionCommandBurstProbeStrengthBonusCharID",
            ),
            (
                PROBE_DEVIATION_BONUS,
                "expeditionCommandBurstProbeDeviationBonusCharID",
            ),
            (MAX_DIRECTIONAL_SCAN_RANGE, "maxDirectionalScanRange"),
            (VIRUS_COHERENCE, "virusCoherence"),
            (MINING_CRIT_CHANCE, "miningCritChance"),
            (MINING_WASTE_PROBABILITY, "miningWasteProbability"),
            (2468, "warfareBuff1ID"),
            (2470, "warfareBuff2ID"),
            (2472, "warfareBuff3ID"),
            (2536, "warfareBuff4ID"),
            (2469, "warfareBuff1Value"),
            (2471, "warfareBuff2Value"),
            (2473, "warfareBuff3Value"),
            (2537, "warfareBuff4Value"),
            (2596, "warfareBuff1Multiplier"),
            (2597, "warfareBuff2Multiplier"),
            (2598, "warfareBuff3Multiplier"),
            (2599, "warfareBuff4Multiplier"),
        ] {
            assert_eq!(attr_name(id), name, "attribute {id}");
        }
        for (id, name) in [
            (SHIELD_OPERATION, "Shield Operation"),
            (SHIELD_EMISSION_SYSTEMS, "Shield Emission Systems"),
            (
                CAP_SHIELD_EMISSION_SYSTEMS,
                "Capital Shield Emission Systems",
            ),
            (REMOTE_ARMOR_REPAIR_SYSTEMS, "Remote Armor Repair Systems"),
            (REPAIR_SYSTEMS, "Repair Systems"),
            (
                CAP_REMOTE_ARMOR_REPAIR_SYSTEMS,
                "Capital Remote Armor Repair Systems",
            ),
            (AFTERBURNER, "Afterburner"),
            (HIGH_SPEED_MANEUVERING, "High Speed Maneuvering"),
            (MINING, "Mining"),
            (ICE_HARVESTING, "Ice Harvesting"),
            (GAS_CLOUD_HARVESTING, "Gas Cloud Harvesting"),
            (ASTROMETRICS, "Astrometrics"),
            (SALVAGING, "Salvaging"),
        ] {
            assert_eq!(type_name(id), name, "skill {id}");
        }
        for (id, name) in [
            (GROUP_ECM, "ECM"),
            (GROUP_SENSOR_DAMPENER, "Sensor Dampener"),
            (GROUP_WEAPON_DISRUPTOR, "Weapon Disruptor"),
            (GROUP_TARGET_PAINTER, "Target Painter"),
            (GROUP_STASIS_WEB, "Stasis Web"),
            (GROUP_WARP_SCRAMBLER, "Warp Scrambler"),
            (GROUP_DATA_MINER, "Data Miners"),
            (GROUP_SALVAGER, "Salvager"),
        ] {
            assert_eq!(group_name(id), name, "group {id}");
        }

        // Every burst charge's (buff, multiplier) pairs equal our `base`.
        let mut stmt = conn
            .prepare(
                "SELECT t.typeID FROM invTypes t JOIN invGroups g USING(groupID) \
                 WHERE g.groupName LIKE '%Burst Charges' AND t.published=1",
            )
            .unwrap();
        let charges: Vec<i64> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(!charges.is_empty());
        let mut seen = std::collections::HashSet::new();
        for cid in charges {
            let val = |attr: i64| -> Option<f64> {
                conn.query_row(
                    "SELECT COALESCE(valueFloat, valueInt) FROM dgmTypeAttributes \
                     WHERE typeID=? AND attributeID=?",
                    [cid, attr],
                    |r| r.get(0),
                )
                .ok()
            };
            for &(id_attr, mult_attr, _) in &SLOTS {
                let Some(id) = val(id_attr).map(|v| v as i64).filter(|v| *v > 0) else {
                    continue;
                };
                let Some(d) = def(id) else {
                    // 2474 (mining scanner upgrade) is deliberately unmodelled.
                    assert_eq!(id, 2474, "burst charge {cid} carries unmodelled buff {id}");
                    continue;
                };
                assert_eq!(val(mult_attr), Some(d.base), "buff {id} on charge {cid}");
                seen.insert(id);
            }
        }
        for b in BUFFS {
            assert!(seen.contains(&b.id), "no SDE charge carries buff {}", b.id);
        }
    }
}
