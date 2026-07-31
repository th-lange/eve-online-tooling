//! Convert ESI saved fittings into our [`Fit`] (#178).
//!
//! ESI lists each fitting item with an inventory `flag` (its slot location) and
//! a quantity; a module and its loaded charge appear as two items sharing the
//! same slot flag. We map the flag to a [`SlotKind`] + index, then pair a slot's
//! charge onto its module. Pure — the command supplies an `is_charge` classifier
//! (SDE category 8) and the SDE-backed fetch.

use crate::esi::EsiFitting;

use super::types::{Fit, FitItem, ModuleState, SlotKind};

/// Map an ESI fitting `flag` string to `(slot kind, index within the slot)`.
/// ESI uses names like `HiSlot0`–`HiSlot7`, `MedSlot0`–7, `LoSlot0`–7,
/// `RigSlot0`–2, `SubSystemSlot0`–4, `DroneBay`, `Cargo`.
pub fn flag_to_slot(flag: &str) -> Option<(SlotKind, i32)> {
    let index_of = |prefix: &str| {
        flag.strip_prefix(prefix)
            .and_then(|n| n.parse::<i32>().ok())
    };
    if let Some(i) = index_of("HiSlot") {
        return Some((SlotKind::High, i));
    }
    if let Some(i) = index_of("MedSlot") {
        return Some((SlotKind::Mid, i));
    }
    if let Some(i) = index_of("LoSlot") {
        return Some((SlotKind::Low, i));
    }
    if let Some(i) = index_of("RigSlot") {
        return Some((SlotKind::Rig, i));
    }
    if let Some(i) = index_of("SubSystemSlot") {
        return Some((SlotKind::Subsystem, i));
    }
    match flag {
        "DroneBay" => Some((SlotKind::Drone, 0)),
        "Cargo" => Some((SlotKind::Cargo, 0)),
        _ => None, // FighterBay / ServiceSlot / implants — not placed in the editor
    }
}

/// Map a `(slot, index)` back to an ESI fitting `flag` string — the inverse of
/// [`flag_to_slot`]. Drones/cargo collapse to their bay regardless of index;
/// implants/boosters aren't part of an ESI fitting (returns `None`).
pub fn slot_to_flag(slot: SlotKind, index: i32) -> Option<String> {
    Some(match slot {
        SlotKind::High => format!("HiSlot{index}"),
        SlotKind::Mid => format!("MedSlot{index}"),
        SlotKind::Low => format!("LoSlot{index}"),
        SlotKind::Rig => format!("RigSlot{index}"),
        SlotKind::Subsystem => format!("SubSystemSlot{index}"),
        SlotKind::Drone => "DroneBay".into(),
        SlotKind::Cargo => "Cargo".into(),
        SlotKind::Implant | SlotKind::Booster => return None,
    })
}

/// One item in an ESI fitting POST body (`type_id`, slot `flag`, `quantity`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct EsiFitItemOut {
    pub flag: String,
    pub quantity: i64,
    pub type_id: i64,
}

/// Flatten a [`Fit`] into the ESI fitting item list for a create-fitting POST: a
/// module per slot, plus its loaded charge as a separate item sharing the module's
/// flag, plus drones/cargo in their bay. Implants/boosters are dropped.
pub fn fit_to_esi_items(fit: &Fit) -> Vec<EsiFitItemOut> {
    let mut out = Vec::new();
    for it in &fit.items {
        let Some(flag) = slot_to_flag(it.slot, it.index) else {
            continue;
        };
        out.push(EsiFitItemOut {
            flag: flag.clone(),
            quantity: it.quantity.max(1) as i64,
            type_id: it.type_id,
        });
        if let Some(charge) = it.charge_type_id {
            out.push(EsiFitItemOut {
                flag,
                quantity: 1,
                type_id: charge,
            });
        }
    }
    out
}

/// Where an ESI fitting came from. Character and corporation fitting ids are
/// issued by separate endpoints with independent id spaces, so the source is
/// part of a fit's identity — without it two unrelated fittings can collide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EsiFitSource {
    Character,
    Corporation,
}

impl EsiFitSource {
    /// Id prefix segment, kept short and stable (it appears in stored ids).
    fn tag(self) -> &'static str {
        match self {
            EsiFitSource::Character => "char",
            EsiFitSource::Corporation => "corp",
        }
    }
}

/// Convert an ESI fitting to a [`Fit`]. `is_charge(type_id)` distinguishes a
/// loaded charge (which rides on its module) from a module. `source` namespaces
/// the generated id so a character and a corporation fitting that happen to
/// share a numeric id stay distinct.
pub fn esi_fitting_to_fit(
    esi: &EsiFitting,
    source: EsiFitSource,
    is_charge: &impl Fn(i64) -> bool,
) -> Fit {
    let mut items: Vec<FitItem> = Vec::new();
    let mut drone_index = 0i32;
    let mut cargo_index = 0i32;

    // Pass 1 — modules, drones and cargo (slot charges handled in pass 2).
    for it in &esi.items {
        let Some((slot, index)) = flag_to_slot(&it.flag) else {
            continue;
        };
        let qty = it.quantity.max(1) as i32;
        match slot {
            SlotKind::Drone => {
                items.push(module(
                    it.type_id,
                    slot,
                    drone_index,
                    ModuleState::Active,
                    qty,
                ));
                drone_index += 1;
            }
            SlotKind::Cargo => {
                items.push(module(
                    it.type_id,
                    slot,
                    cargo_index,
                    ModuleState::Active,
                    qty,
                ));
                cargo_index += 1;
            }
            _ if is_charge(it.type_id) => {} // attached in pass 2
            _ => items.push(module(it.type_id, slot, index, ModuleState::Active, 1)),
        }
    }

    // Pass 2 — attach each slot charge to the module sharing its flag; an orphan
    // charge (no host module) is kept as cargo so nothing is silently dropped.
    for it in &esi.items {
        if !is_charge(it.type_id) {
            continue;
        }
        let Some((slot, index)) = flag_to_slot(&it.flag) else {
            continue;
        };
        if matches!(slot, SlotKind::Drone | SlotKind::Cargo) {
            continue; // already added in pass 1
        }
        match items
            .iter_mut()
            .find(|m| m.slot == slot && m.index == index)
        {
            Some(host) => host.charge_type_id = Some(it.type_id),
            None => {
                items.push(module(
                    it.type_id,
                    SlotKind::Cargo,
                    cargo_index,
                    ModuleState::Active,
                    it.quantity.max(1) as i32,
                ));
                cargo_index += 1;
            }
        }
    }

    Fit {
        id: format!("esi:{}:{}", source.tag(), esi.fitting_id),
        name: if esi.name.is_empty() {
            format!("Fitting {}", esi.fitting_id)
        } else {
            esi.name.clone()
        },
        ship_type_id: esi.ship_type_id,
        items,
        projected: Vec::new(),
    }
}

fn module(type_id: i64, slot: SlotKind, index: i32, state: ModuleState, quantity: i32) -> FitItem {
    FitItem {
        type_id,
        slot,
        index,
        state,
        charge_type_id: None,
        quantity,
        active_drones: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::esi::EsiFitting;

    // EsiFitting/EsiFitItem fields are crate-public; build via JSON to avoid
    // depending on field visibility in tests.
    fn fitting(json: &str) -> EsiFitting {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn maps_flags_to_slots() {
        assert_eq!(flag_to_slot("LoSlot0"), Some((SlotKind::Low, 0)));
        assert_eq!(flag_to_slot("LoSlot3"), Some((SlotKind::Low, 3)));
        assert_eq!(flag_to_slot("MedSlot0"), Some((SlotKind::Mid, 0)));
        assert_eq!(flag_to_slot("HiSlot0"), Some((SlotKind::High, 0)));
        assert_eq!(flag_to_slot("RigSlot0"), Some((SlotKind::Rig, 0)));
        assert_eq!(flag_to_slot("DroneBay"), Some((SlotKind::Drone, 0)));
        assert_eq!(flag_to_slot("Cargo"), Some((SlotKind::Cargo, 0)));
        assert_eq!(
            flag_to_slot("SubSystemSlot0"),
            Some((SlotKind::Subsystem, 0))
        );
        assert_eq!(flag_to_slot("FighterBay"), None);
    }

    #[test]
    fn slot_to_flag_round_trips_and_drops_implants() {
        for (slot, idx) in [
            (SlotKind::High, 2),
            (SlotKind::Mid, 0),
            (SlotKind::Low, 3),
            (SlotKind::Rig, 1),
            (SlotKind::Subsystem, 4),
        ] {
            let flag = slot_to_flag(slot, idx).unwrap();
            assert_eq!(flag_to_slot(&flag), Some((slot, idx)));
        }
        assert_eq!(
            slot_to_flag(SlotKind::Drone, 5).as_deref(),
            Some("DroneBay")
        );
        assert_eq!(slot_to_flag(SlotKind::Cargo, 0).as_deref(), Some("Cargo"));
        assert_eq!(slot_to_flag(SlotKind::Implant, 0), None);
    }

    #[test]
    fn fit_to_esi_items_emits_modules_charges_and_drops_implants() {
        let mut gun = module(10, SlotKind::High, 0, ModuleState::Active, 1);
        gun.charge_type_id = Some(11);
        let fit = Fit {
            id: "x".into(),
            name: "n".into(),
            ship_type_id: 587,
            items: vec![
                gun,
                module(20, SlotKind::Drone, 0, ModuleState::Active, 5),
                module(30, SlotKind::Implant, 0, ModuleState::Online, 1),
            ],
            projected: Vec::new(),
        };
        let out = fit_to_esi_items(&fit);
        // The high module + its charge (shared flag), then the drone stack; the
        // implant is dropped.
        assert_eq!(out.len(), 3);
        assert_eq!(
            out[0],
            EsiFitItemOut {
                flag: "HiSlot0".into(),
                quantity: 1,
                type_id: 10
            }
        );
        assert_eq!(
            out[1],
            EsiFitItemOut {
                flag: "HiSlot0".into(),
                quantity: 1,
                type_id: 11
            }
        );
        assert_eq!(
            out[2],
            EsiFitItemOut {
                flag: "DroneBay".into(),
                quantity: 5,
                type_id: 20
            }
        );
    }

    #[test]
    fn pairs_charge_with_its_module_and_keeps_drones() {
        // HiSlot0: a gun (100) + its charge (200). DroneBay: 5 drones.
        let f = fitting(
            r#"{"fitting_id": 7, "name": "Rifter", "description": "", "ship_type_id": 587,
                "items": [
                  {"type_id": 100, "flag": "HiSlot0", "quantity": 1},
                  {"type_id": 200, "flag": "HiSlot0", "quantity": 1},
                  {"type_id": 300, "flag": "DroneBay", "quantity": 5},
                  {"type_id": 200, "flag": "Cargo", "quantity": 1000}
                ]}"#,
        );
        // 200 is a charge; 100/300 are not.
        let fit = esi_fitting_to_fit(&f, EsiFitSource::Character, &|tid| tid == 200);
        assert_eq!(fit.id, "esi:char:7");
        assert_eq!(fit.ship_type_id, 587);

        let gun = fit.items.iter().find(|i| i.type_id == 100).unwrap();
        assert_eq!(gun.slot, SlotKind::High);
        assert_eq!(gun.charge_type_id, Some(200));

        let drone = fit
            .items
            .iter()
            .find(|i| i.slot == SlotKind::Drone)
            .unwrap();
        assert_eq!(drone.type_id, 300);
        assert_eq!(drone.quantity, 5);

        // The cargo charge stays as a cargo line (quantity preserved).
        let cargo = fit
            .items
            .iter()
            .find(|i| i.slot == SlotKind::Cargo)
            .unwrap();
        assert_eq!(cargo.type_id, 200);
        assert_eq!(cargo.quantity, 1000);
    }

    #[test]
    fn character_and_corp_fittings_with_one_id_stay_distinct() {
        // The two endpoints have independent id spaces, so the same numeric id
        // can name two unrelated fittings.
        let f = fitting(
            r#"{"fitting_id": 7, "name": "Rifter", "description": "", "ship_type_id": 587,
                "items": [{"type_id": 100, "flag": "HiSlot0", "quantity": 1}]}"#,
        );
        let mine = esi_fitting_to_fit(&f, EsiFitSource::Character, &|_| false);
        let ours = esi_fitting_to_fit(&f, EsiFitSource::Corporation, &|_| false);
        assert_ne!(mine.id, ours.id);
        assert_eq!(mine.id, "esi:char:7");
        assert_eq!(ours.id, "esi:corp:7");
    }
}
