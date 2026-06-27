//! EFT clipboard format — pure parse/serialize (#162).
//!
//! EFT is the de-facto plain-text fitting interchange:
//!
//! ```text
//! [Rifter, My Rifter]
//!
//! Gyrostabilizer II
//! [Empty Low slot]
//!
//! 1MN Afterburner II
//!
//! 200mm AutoCannon II, Barrage S
//! 200mm AutoCannon II, Barrage S
//!
//! Hobgoblin II x5
//!
//! Barrage S x500
//! ```
//!
//! This module only handles the **text ↔ structure** mapping; it never touches
//! the SDE. A line's slot is *not* in the text — it comes from the module's
//! dogma effect — so the pure parser emits names + an `xN` quantity and leaves
//! type-id/slot resolution to the command layer (which has the SDE). The one
//! exception is `[Empty <Slot> slot]` placeholders, which name their slot.

use serde::Serialize;

use super::types::SlotKind;

/// A line that carries a module name and an optional charge (`Module, Charge`),
/// or an explicit empty-slot placeholder.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParsedModule {
    pub name: String,
    pub charge: Option<String>,
    /// `Some(slot)` for an `[Empty <Slot> slot]` placeholder (no module).
    pub empty_slot: Option<SlotKind>,
}

/// A trailing line with an `xN` count — a drone or cargo item (disambiguated by
/// the SDE later).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParsedExtra {
    pub name: String,
    pub quantity: i32,
}

/// A parsed EFT block before SDE resolution.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParsedEft {
    pub ship_name: String,
    pub fit_name: String,
    /// Fitted-module lines in source order; slot inferred later from dogma.
    pub modules: Vec<ParsedModule>,
    /// Drone/cargo lines (`Name xN`) in source order.
    pub extras: Vec<ParsedExtra>,
}

/// Why an EFT string couldn't be parsed.
#[derive(Debug, Clone, PartialEq)]
pub enum EftError {
    /// The `[Ship, name]` header line was missing or malformed.
    MissingHeader,
}

impl std::fmt::Display for EftError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EftError::MissingHeader => write!(f, "EFT is missing its [Ship, name] header"),
        }
    }
}

/// Map an empty-slot placeholder word to a [`SlotKind`].
fn empty_slot_kind(word: &str) -> Option<SlotKind> {
    match word.to_ascii_lowercase().as_str() {
        "high" => Some(SlotKind::High),
        "med" | "medium" => Some(SlotKind::Mid),
        "low" => Some(SlotKind::Low),
        "rig" => Some(SlotKind::Rig),
        "subsystem" => Some(SlotKind::Subsystem),
        _ => None,
    }
}

/// Parse a `Name xN` trailing-quantity line into `(name, quantity)`, or `None`
/// if it has no `xN` suffix. The suffix must be a trailing ` x<digits>`.
fn split_quantity(line: &str) -> Option<(&str, i32)> {
    let (name, count) = line.rsplit_once(" x")?;
    let qty: i32 = count.trim().parse().ok()?;
    let name = name.trim();
    (!name.is_empty() && qty > 0).then_some((name, qty))
}

/// Parse an EFT string into its structural [`ParsedEft`] form (pure — no SDE).
///
/// Heuristics, matching the common in-game / PYFA export:
/// - `[Ship, fit name]` header (required).
/// - `[Empty <Slot> slot]` → an empty-slot placeholder (kept for fidelity).
/// - `Name xN` → a drone/cargo extra.
/// - `Module, Charge` → a module with a loaded charge.
/// - anything else → a bare module.
pub fn parse_eft(text: &str) -> Result<ParsedEft, EftError> {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());

    // Header: `[Ship, fit name]`.
    let header = lines.next().ok_or(EftError::MissingHeader)?;
    let inner = header
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .ok_or(EftError::MissingHeader)?;
    let (ship_name, fit_name) = inner.split_once(',').ok_or(EftError::MissingHeader)?;
    let ship_name = ship_name.trim().to_string();
    let fit_name = fit_name.trim().to_string();
    if ship_name.is_empty() {
        return Err(EftError::MissingHeader);
    }

    let mut modules = Vec::new();
    let mut extras = Vec::new();
    for line in lines {
        // `[Empty High slot]` placeholder.
        if let Some(inner) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let word = inner
                .trim()
                .strip_prefix("Empty ")
                .and_then(|w| w.strip_suffix(" slot"))
                .unwrap_or("");
            modules.push(ParsedModule {
                name: String::new(),
                charge: None,
                empty_slot: empty_slot_kind(word).or(Some(SlotKind::High)),
            });
            continue;
        }
        // `Name xN` → drone/cargo extra.
        if let Some((name, qty)) = split_quantity(line) {
            extras.push(ParsedExtra {
                name: name.to_string(),
                quantity: qty,
            });
            continue;
        }
        // `Module, Charge` or a bare module.
        let (name, charge) = match line.split_once(',') {
            Some((m, c)) => (m.trim().to_string(), Some(c.trim().to_string())),
            None => (line.to_string(), None),
        };
        modules.push(ParsedModule {
            name,
            charge,
            empty_slot: None,
        });
    }

    Ok(ParsedEft {
        ship_name,
        fit_name,
        modules,
        extras,
    })
}

/// Serialize a [`ParsedEft`] back to EFT text. Modules are emitted in their
/// stored order (the caller groups them by slot); extras follow after a blank
/// line. Round-trips with [`parse_eft`].
pub fn format_eft(fit: &ParsedEft) -> String {
    let mut out = format!("[{}, {}]\n", fit.ship_name, fit.fit_name);
    if !fit.modules.is_empty() {
        out.push('\n');
        for m in &fit.modules {
            match (&m.empty_slot, &m.charge) {
                (Some(slot), _) => out.push_str(&format!("[Empty {} slot]\n", slot_word(*slot))),
                (None, Some(charge)) => out.push_str(&format!("{}, {}\n", m.name, charge)),
                (None, None) => out.push_str(&format!("{}\n", m.name)),
            }
        }
    }
    if !fit.extras.is_empty() {
        out.push('\n');
        for e in &fit.extras {
            out.push_str(&format!("{} x{}\n", e.name, e.quantity));
        }
    }
    out
}

/// The EFT placeholder word for a slot kind.
fn slot_word(slot: SlotKind) -> &'static str {
    match slot {
        SlotKind::High => "High",
        SlotKind::Mid => "Med",
        SlotKind::Low => "Low",
        SlotKind::Rig => "Rig",
        SlotKind::Subsystem => "Subsystem",
        // Non-slot kinds never appear as empty placeholders.
        _ => "High",
    }
}

/// Classify a module into its [`SlotKind`] from the set of dogma effect ids it
/// carries (pure). `None` when no slot-defining effect is present (e.g. a
/// charge or drone). Slot effect ids verified against the SDE (#162):
/// hiPower 12, medPower 13, loPower 11, rigSlot 2663, subSystem 3772.
pub fn slot_for_effects(effect_ids: &[i64]) -> Option<SlotKind> {
    for &e in effect_ids {
        match e {
            12 => return Some(SlotKind::High),
            13 => return Some(SlotKind::Mid),
            11 => return Some(SlotKind::Low),
            2663 => return Some(SlotKind::Rig),
            3772 => return Some(SlotKind::Subsystem),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "[Rifter, My Rifter]\n\
\n\
Gyrostabilizer II\n\
[Empty Low slot]\n\
\n\
1MN Afterburner II\n\
Warp Scrambler II\n\
\n\
200mm AutoCannon II, Barrage S\n\
200mm AutoCannon II, Barrage S\n\
\n\
Hobgoblin II x5\n\
\n\
Barrage S x500\n";

    #[test]
    fn parses_header_modules_charges_and_extras() {
        let fit = parse_eft(SAMPLE).unwrap();
        assert_eq!(fit.ship_name, "Rifter");
        assert_eq!(fit.fit_name, "My Rifter");
        // 5 module lines: gyro, empty low, AB, scram, 2x autocannon = 6 actually.
        assert_eq!(fit.modules.len(), 6);
        assert_eq!(fit.modules[0].name, "Gyrostabilizer II");
        assert_eq!(fit.modules[1].empty_slot, Some(SlotKind::Low));
        let gun = &fit.modules[4];
        assert_eq!(gun.name, "200mm AutoCannon II");
        assert_eq!(gun.charge.as_deref(), Some("Barrage S"));
        // Drone + cargo extras.
        assert_eq!(
            fit.extras,
            vec![
                ParsedExtra { name: "Hobgoblin II".into(), quantity: 5 },
                ParsedExtra { name: "Barrage S".into(), quantity: 500 },
            ]
        );
    }

    #[test]
    fn round_trips_text_to_struct_to_text() {
        let fit = parse_eft(SAMPLE).unwrap();
        let text = format_eft(&fit);
        // Re-parsing the serialized form yields the same structure.
        assert_eq!(parse_eft(&text).unwrap(), fit);
    }

    #[test]
    fn rejects_missing_or_malformed_header() {
        assert_eq!(parse_eft(""), Err(EftError::MissingHeader));
        assert_eq!(parse_eft("Gyrostabilizer II"), Err(EftError::MissingHeader));
        assert_eq!(parse_eft("[NoComma]"), Err(EftError::MissingHeader));
    }

    #[test]
    fn quantity_split_is_trailing_only() {
        // A trailing ` xN` is a count; an internal ' x' (none here) is not.
        assert_eq!(split_quantity("Hobgoblin II x5"), Some(("Hobgoblin II", 5)));
        assert_eq!(split_quantity("Warp Scrambler II"), None);
        assert_eq!(split_quantity("Item x0"), None); // zero is not a valid count
    }

    #[test]
    fn classifies_slot_from_effects() {
        assert_eq!(slot_for_effects(&[16, 11]), Some(SlotKind::Low)); // online + loPower
        assert_eq!(slot_for_effects(&[12]), Some(SlotKind::High));
        assert_eq!(slot_for_effects(&[2663]), Some(SlotKind::Rig));
        assert_eq!(slot_for_effects(&[16]), None); // online only — not a slot
    }
}
