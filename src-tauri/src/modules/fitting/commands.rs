//! Tauri command surface for the fitting module.
//!
//! Commands open the SDE read-only per call (cheap) and orchestrate the shared
//! services, like the production module. P1 adds pricing/validation/storage
//! commands here; the dogma `simulate` command lands with the engine (P2).

use std::collections::HashMap;

use tauri::{AppHandle, Manager};

use super::eft::{self, ParsedEft, ParsedExtra, ParsedModule};
use super::types::{Fit, FitItem, ModuleState, SlotKind};
use crate::sde::{Sde, SdePaths, ShipLayout};

/// Open the SDE for the current app data dir (read-only, cheap per call).
fn open_sde(app: &AppHandle) -> Result<Sde, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())
}

/// A stable-enough local id for a freshly imported fit (no `uuid` dependency).
fn new_fit_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

/// A hull's slot layout + fitting resources, for the empty editor (#160).
/// `None` if the type id isn't a known ship.
#[tauri::command]
pub fn fitting_ship_layout(app: AppHandle, type_id: i64) -> Result<Option<ShipLayout>, String> {
    open_sde(&app)?
        .ship_layout(type_id)
        .map_err(|e| e.to_string())
}

/// Parse an EFT clipboard string into a [`Fit`], resolving names → type ids and
/// classifying each module into its slot from dogma effects (#162). Unknown
/// module/charge names are skipped rather than failing the whole import; an
/// unknown ship is an error.
#[tauri::command]
pub fn fitting_import_eft(app: AppHandle, text: String) -> Result<Fit, String> {
    let sde = open_sde(&app)?;
    let parsed = eft::parse_eft(&text).map_err(|e| e.to_string())?;

    let ship_type_id = sde
        .type_by_name(&parsed.ship_name)
        .map_err(|e| e.to_string())?
        .map(|(id, _)| id)
        .ok_or_else(|| format!("unknown ship: {}", parsed.ship_name))?;

    let mut items = Vec::new();
    // Next free index within each slot kind, in source order.
    let mut next_index: HashMap<SlotKind, i32> = HashMap::new();
    let take_index = |slot: SlotKind, map: &mut HashMap<SlotKind, i32>| {
        let n = map.entry(slot).or_default();
        let idx = *n;
        *n += 1;
        idx
    };

    for m in &parsed.modules {
        // Empty placeholder: advance the slot's index, add no item.
        if let Some(slot) = m.empty_slot {
            take_index(slot, &mut next_index);
            continue;
        }
        let Some((type_id, _)) = sde.type_by_name(&m.name).map_err(|e| e.to_string())? else {
            continue; // unknown module — skip
        };
        let effects: Vec<i64> = sde
            .type_effects(type_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(e, _)| e)
            .collect();
        let slot = eft::slot_for_effects(&effects).unwrap_or(SlotKind::Cargo);
        let charge_type_id = match &m.charge {
            Some(c) => sde
                .type_by_name(c)
                .map_err(|e| e.to_string())?
                .map(|(id, _)| id),
            None => None,
        };
        items.push(FitItem {
            type_id,
            slot,
            index: take_index(slot, &mut next_index),
            state: ModuleState::Online,
            charge_type_id,
            quantity: 1,
        });
    }

    for e in &parsed.extras {
        let Some((type_id, _)) = sde.type_by_name(&e.name).map_err(|e| e.to_string())? else {
            continue;
        };
        // Category 18 = Drone; everything else trailing is cargo.
        let slot = match sde.type_category(type_id).map_err(|e| e.to_string())? {
            Some(18) => SlotKind::Drone,
            _ => SlotKind::Cargo,
        };
        items.push(FitItem {
            type_id,
            slot,
            index: take_index(slot, &mut next_index),
            state: ModuleState::Active,
            charge_type_id: None,
            quantity: e.quantity,
        });
    }

    Ok(Fit {
        id: new_fit_id(),
        name: parsed.fit_name,
        ship_type_id,
        items,
    })
}

/// Serialize a [`Fit`] to an EFT clipboard string (#162). Modules are grouped by
/// slot (high → mid → low → rig → subsystem) in index order; drones and cargo
/// follow as `Name xN` lines.
#[tauri::command]
pub fn fitting_export_eft(app: AppHandle, fit: Fit) -> Result<String, String> {
    let sde = open_sde(&app)?;
    let name_of = |id: i64| -> Result<String, String> {
        Ok(sde
            .type_info(id)
            .map_err(|e| e.to_string())?
            .map(|t| t.name)
            .unwrap_or_else(|| format!("Type {id}")))
    };

    let ship_name = name_of(fit.ship_type_id)?;

    let mut modules = Vec::new();
    for slot in [
        SlotKind::High,
        SlotKind::Mid,
        SlotKind::Low,
        SlotKind::Rig,
        SlotKind::Subsystem,
    ] {
        let mut in_slot: Vec<&FitItem> = fit.items.iter().filter(|i| i.slot == slot).collect();
        in_slot.sort_by_key(|i| i.index);
        for i in in_slot {
            let charge = match i.charge_type_id {
                Some(c) => Some(name_of(c)?),
                None => None,
            };
            modules.push(ParsedModule {
                name: name_of(i.type_id)?,
                charge,
                empty_slot: None,
            });
        }
    }

    let mut extras = Vec::new();
    for i in fit
        .items
        .iter()
        .filter(|i| matches!(i.slot, SlotKind::Drone | SlotKind::Cargo))
    {
        extras.push(ParsedExtra {
            name: name_of(i.type_id)?,
            quantity: i.quantity,
        });
    }

    Ok(eft::format_eft(&ParsedEft {
        ship_name,
        fit_name: fit.name.clone(),
        modules,
        extras,
    }))
}
