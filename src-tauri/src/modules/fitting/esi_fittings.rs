//! Convert ESI saved fittings into our [`Fit`] (#178).
//!
//! ESI lists each fitting item with an inventory `flag` (its slot location) and
//! a quantity; a module and its loaded charge appear as two items sharing the
//! same slot flag. We map the flag to a [`SlotKind`] + index, then pair a slot's
//! charge onto its module. Pure — the command supplies an `is_charge` classifier
//! (SDE category 8) and the SDE-backed fetch.

use crate::esi::EsiFitting;

use super::types::{Fit, FitItem, ModuleState, SlotKind};

/// Map an EVE inventory `flag` to `(slot kind, index within the slot)`.
/// Flags: LoSlot0–7 = 11–18, MedSlot0–7 = 19–26, HiSlot0–7 = 27–34,
/// RigSlot0–2 = 92–94, SubSystemSlot0–4 = 125–129, DroneBay = 87, Cargo = 5.
pub fn flag_to_slot(flag: i64) -> Option<(SlotKind, i32)> {
    match flag {
        11..=18 => Some((SlotKind::Low, (flag - 11) as i32)),
        19..=26 => Some((SlotKind::Mid, (flag - 19) as i32)),
        27..=34 => Some((SlotKind::High, (flag - 27) as i32)),
        92..=98 => Some((SlotKind::Rig, (flag - 92) as i32)),
        125..=132 => Some((SlotKind::Subsystem, (flag - 125) as i32)),
        87 => Some((SlotKind::Drone, 0)),
        5 => Some((SlotKind::Cargo, 0)),
        _ => None, // implants/boosters/etc. — not placed in the editor
    }
}

/// Convert an ESI fitting to a [`Fit`]. `is_charge(type_id)` distinguishes a
/// loaded charge (which rides on its module) from a module.
pub fn esi_fitting_to_fit(esi: &EsiFitting, is_charge: &impl Fn(i64) -> bool) -> Fit {
    let mut items: Vec<FitItem> = Vec::new();
    let mut drone_index = 0i32;
    let mut cargo_index = 0i32;

    // Pass 1 — modules, drones and cargo (slot charges handled in pass 2).
    for it in &esi.items {
        let Some((slot, index)) = flag_to_slot(it.flag) else {
            continue;
        };
        let qty = it.quantity.max(1) as i32;
        match slot {
            SlotKind::Drone => {
                items.push(module(it.type_id, slot, drone_index, ModuleState::Active, qty));
                drone_index += 1;
            }
            SlotKind::Cargo => {
                items.push(module(it.type_id, slot, cargo_index, ModuleState::Active, qty));
                cargo_index += 1;
            }
            _ if is_charge(it.type_id) => {} // attached in pass 2
            _ => items.push(module(it.type_id, slot, index, ModuleState::Online, 1)),
        }
    }

    // Pass 2 — attach each slot charge to the module sharing its flag; an orphan
    // charge (no host module) is kept as cargo so nothing is silently dropped.
    for it in &esi.items {
        if !is_charge(it.type_id) {
            continue;
        }
        let Some((slot, index)) = flag_to_slot(it.flag) else {
            continue;
        };
        if matches!(slot, SlotKind::Drone | SlotKind::Cargo) {
            continue; // already added in pass 1
        }
        match items.iter_mut().find(|m| m.slot == slot && m.index == index) {
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
        id: format!("esi:{}", esi.fitting_id),
        name: if esi.name.is_empty() {
            format!("Fitting {}", esi.fitting_id)
        } else {
            esi.name.clone()
        },
        ship_type_id: esi.ship_type_id,
        items,
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
        assert_eq!(flag_to_slot(11), Some((SlotKind::Low, 0)));
        assert_eq!(flag_to_slot(14), Some((SlotKind::Low, 3)));
        assert_eq!(flag_to_slot(19), Some((SlotKind::Mid, 0)));
        assert_eq!(flag_to_slot(27), Some((SlotKind::High, 0)));
        assert_eq!(flag_to_slot(92), Some((SlotKind::Rig, 0)));
        assert_eq!(flag_to_slot(87), Some((SlotKind::Drone, 0)));
        assert_eq!(flag_to_slot(5), Some((SlotKind::Cargo, 0)));
        assert_eq!(flag_to_slot(125), Some((SlotKind::Subsystem, 0)));
        assert_eq!(flag_to_slot(2000), None);
    }

    #[test]
    fn pairs_charge_with_its_module_and_keeps_drones() {
        // HiSlot0 (27): a gun (100) + its charge (200). DroneBay (87): 5 drones.
        let f = fitting(
            r#"{"fitting_id": 7, "name": "Rifter", "description": "", "ship_type_id": 587,
                "items": [
                  {"type_id": 100, "flag": 27, "quantity": 1},
                  {"type_id": 200, "flag": 27, "quantity": 1},
                  {"type_id": 300, "flag": 87, "quantity": 5},
                  {"type_id": 200, "flag": 5, "quantity": 1000}
                ]}"#,
        );
        // 200 is a charge; 100/300 are not.
        let fit = esi_fitting_to_fit(&f, &|tid| tid == 200);
        assert_eq!(fit.id, "esi:7");
        assert_eq!(fit.ship_type_id, 587);

        let gun = fit.items.iter().find(|i| i.type_id == 100).unwrap();
        assert_eq!(gun.slot, SlotKind::High);
        assert_eq!(gun.charge_type_id, Some(200));

        let drone = fit.items.iter().find(|i| i.slot == SlotKind::Drone).unwrap();
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
}
