//! Ship DNA — pure parse/serialize (#879).
//!
//! DNA is the compact single-line format behind in-game chat fit links and
//! killboard links. The formal grammar (EVE Developer Documentation,
//! <https://developers.eveonline.com/docs/guides/fitting/>):
//!
//! ```text
//! DNA -> SHIP ':' HIGHS ':' MEDS ':' LOWS ':' RIGS ':' CHARGES
//! SHIP -> SHIP_TYPE_ID ( ':' SUBSYSTEM_ID ':' SUBSYSTEM_ID ':' SUBSYSTEM_ID ':' SUBSYSTEM_ID ':' SUBSYSTEM_ID )
//! HIGHS -> EMPTY | MODULE ( ':' MODULE )
//! MEDS -> EMPTY | MODULE ( ':' MODULE )
//! LOWS -> EMPTY | MODULE ( ':' MODULE )
//! RIGS -> EMPTY | MODULE ( ':' MODULE )
//! CHARGES -> EMPTY | CHARGE ( ':' CHARGE )
//! MODULE -> MODULE_ID ( '_' ) ';' QUANTITY
//! CHARGE -> CHARGE_ID ';' QUANTITY
//! ```
//!
//! In practice the HIGHS/MEDS/LOWS/RIGS/CHARGES boundaries aren't
//! distinguishable in the text itself — there's no separate delimiter between
//! sections vs. between modules within a section, and the real client/
//! killboard generator never emits section markers for empty sections either.
//! Every client-generated DNA string is really just `SHIP` followed by one
//! flat, colon-separated run of `id[_];qty` tokens (subsystems, modules,
//! drones, charges — indistinguishable at the text level) terminated by a
//! literal `::`. Slot membership comes from each type's own dogma effects at
//! resolution time, exactly like EFT (see `eft::slot_for_effects`) — this
//! module only handles the **text ↔ structure** mapping and never touches the
//! SDE. A trailing `_` on a module id marks it explicitly unfitted; charges
//! are always considered unfitted regardless of the marker.
//!
//! Example (a real killboard-style DNA string, Heron Navy Issue):
//! `72904:4250;2:4258;1:11577;1:33199;1:33201;1:33197;1:9580;1:9568;1:1405;2:31220;1:31788;1:30488;8::`

use serde::Serialize;

/// One flat DNA token: an id and its quantity, with the optional `_`
/// "explicitly unfitted" marker.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct DnaItem {
    pub type_id: i64,
    pub quantity: i32,
    /// A trailing `_` before `;quantity` — explicitly unfitted. Charges are
    /// always unfitted regardless of this flag; it matters for modules.
    pub unfitted: bool,
}

/// A parsed DNA string before SDE resolution: the ship plus every other
/// token in source order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParsedDna {
    pub ship_type_id: i64,
    pub items: Vec<DnaItem>,
}

/// Why a DNA string couldn't be parsed.
#[derive(Debug, Clone, PartialEq)]
pub enum DnaError {
    /// No leading `SHIP_TYPE_ID` integer.
    MissingShip,
    /// No `::` terminator anywhere in the string.
    MissingTerminator,
}

impl std::fmt::Display for DnaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DnaError::MissingShip => write!(f, "DNA is missing its leading ship type id"),
            DnaError::MissingTerminator => write!(f, "DNA is missing its `::` terminator"),
        }
    }
}

/// Strip an in-game chat fit-link wrapper (`<url=fitting:...>Name</url>`),
/// if present, down to its DNA payload. A no-op for a bare DNA string.
fn strip_link_wrapper(text: &str) -> &str {
    match text.strip_prefix("<url=fitting:") {
        Some(rest) => rest.split('>').next().unwrap_or(rest),
        None => text,
    }
}

/// Shape check for import-format auto-detection: does `text` look like a DNA
/// string (as opposed to EFT, which always starts with `[Ship, name]`)?
/// Pure and cheap — a leading digit (after stripping an optional chat-link
/// wrapper) plus the `::` terminator somewhere in the string.
pub fn looks_like_dna(text: &str) -> bool {
    let text = strip_link_wrapper(text.trim());
    text.chars().next().is_some_and(|c| c.is_ascii_digit()) && text.contains("::")
}

/// Parse a DNA string into its structural [`ParsedDna`] form (pure — no SDE).
/// Accepts a bare DNA string or one wrapped in an in-game chat fit link
/// (`<url=fitting:...>Name</url>`). Truncates at the first `::` terminator,
/// matching the killboard/client convention (trailing text — an in-game link
/// label, a pasted chat message — is ignored). A malformed item token (not
/// `id`, `id_`, `id;qty` or `id_;qty`) is skipped rather than failing the
/// whole import.
pub fn parse_dna(text: &str) -> Result<ParsedDna, DnaError> {
    let text = strip_link_wrapper(text.trim());
    let end = text.find("::").ok_or(DnaError::MissingTerminator)?;
    let head = &text[..end + 2];

    let mut tokens = head.split(':');
    let ship_type_id: i64 = tokens
        .next()
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse().ok())
        .ok_or(DnaError::MissingShip)?;

    let mut items = Vec::new();
    for token in tokens {
        if token.is_empty() {
            continue; // the trailing `::` terminator (and any empty section)
        }
        let (id_part, quantity) = match token.split_once(';') {
            Some((id, q)) => (id, q.parse().unwrap_or(1)),
            None => (token, 1),
        };
        let (id_part, unfitted) = match id_part.strip_suffix('_') {
            Some(stripped) => (stripped, true),
            None => (id_part, false),
        };
        let Ok(type_id) = id_part.parse::<i64>() else {
            continue; // malformed item token — skip
        };
        items.push(DnaItem {
            type_id,
            quantity: quantity.max(1),
            unfitted,
        });
    }

    Ok(ParsedDna {
        ship_type_id,
        items,
    })
}

/// Serialize a [`ParsedDna`] back to DNA text. Round-trips with
/// [`parse_dna`] — items are emitted in their stored order.
pub fn format_dna(dna: &ParsedDna) -> String {
    let mut out = dna.ship_type_id.to_string();
    for item in &dna.items {
        out.push(':');
        out.push_str(&item.type_id.to_string());
        if item.unfitted {
            out.push('_');
        }
        out.push(';');
        out.push_str(&item.quantity.to_string());
    }
    out.push_str("::");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real killboard-style DNA string (EVE Developer Documentation's
    /// example fit, "Heron Navy Issue"): 11 modules across highs/mids/lows/
    /// rigs plus a stack of 8 scanner probes (a "charge"-category item) in
    /// cargo, no subsystems.
    const HERON: &str = "72904:4250;2:4258;1:11577;1:33199;1:33201;1:33197;1:9580;1:9568;1:1405;2:31220;1:31788;1:30488;8::";

    #[test]
    fn parses_ship_and_flat_item_list() {
        let dna = parse_dna(HERON).unwrap();
        assert_eq!(dna.ship_type_id, 72904);
        assert_eq!(dna.items.len(), 12);
        assert_eq!(
            dna.items[0],
            DnaItem {
                type_id: 4250,
                quantity: 2,
                unfitted: false
            }
        );
        assert_eq!(
            dna.items.last(),
            Some(&DnaItem {
                type_id: 30488,
                quantity: 8,
                unfitted: false
            })
        );
    }

    #[test]
    fn round_trips_text_to_struct_to_text() {
        let dna = parse_dna(HERON).unwrap();
        let text = format_dna(&dna);
        assert_eq!(text, HERON, "canonical DNA round-trips byte for byte");
        assert_eq!(parse_dna(&text).unwrap(), dna);
    }

    /// A real T3 cruiser DNA string built from actual Legion + subsystem
    /// type ids: 4 subsystems (core/defensive/offensive/propulsion) ahead of
    /// the regular modules, matching how the client always orders them.
    const LEGION_T3C: &str =
        "29986:45623;1:45587;1:45599;1:45611;1:2889;2:519;1:2456;5:12625;100::";

    #[test]
    fn parses_t3_cruiser_with_subsystems() {
        let dna = parse_dna(LEGION_T3C).unwrap();
        assert_eq!(dna.ship_type_id, 29986);
        // 4 subsystems + 2 modules + 1 drone stack + 1 charge stack.
        assert_eq!(dna.items.len(), 8);
        let subsystem_ids: Vec<i64> = dna.items[..4].iter().map(|i| i.type_id).collect();
        assert_eq!(subsystem_ids, vec![45623, 45587, 45599, 45611]);
        assert!(dna.items[..4].iter().all(|i| i.quantity == 1));
        let drone = dna.items[6];
        assert_eq!(drone.type_id, 2456);
        assert_eq!(drone.quantity, 5);
    }

    #[test]
    fn round_trips_t3_cruiser_with_subsystems() {
        let dna = parse_dna(LEGION_T3C).unwrap();
        let text = format_dna(&dna);
        assert_eq!(text, LEGION_T3C);
        assert_eq!(parse_dna(&text).unwrap(), dna);
    }

    #[test]
    fn strips_in_game_chat_link_wrapper() {
        let wrapped = format!("<url=fitting:{HERON}>Deepflow Rift Dredger</url>");
        assert_eq!(parse_dna(&wrapped).unwrap(), parse_dna(HERON).unwrap());
    }

    #[test]
    fn parses_explicit_unfitted_marker() {
        let dna = parse_dna("587:519_;1::").unwrap();
        assert_eq!(
            dna.items[0],
            DnaItem {
                type_id: 519,
                quantity: 1,
                unfitted: true
            }
        );
    }

    #[test]
    fn rejects_missing_terminator_or_ship() {
        assert_eq!(parse_dna("587:519;1"), Err(DnaError::MissingTerminator));
        assert_eq!(parse_dna("::"), Err(DnaError::MissingShip));
        assert_eq!(parse_dna(""), Err(DnaError::MissingTerminator));
    }

    #[test]
    fn skips_malformed_item_tokens() {
        let dna = parse_dna("587:519;1:not-a-number;3::").unwrap();
        assert_eq!(
            dna.items,
            vec![DnaItem {
                type_id: 519,
                quantity: 1,
                unfitted: false
            }]
        );
    }

    #[test]
    fn detects_dna_shape_vs_eft() {
        assert!(looks_like_dna(HERON));
        assert!(looks_like_dna("  72904:4250;2::  "));
        assert!(looks_like_dna("<url=fitting:587:519;1::>My Rifter</url>"));
        assert!(!looks_like_dna("[Rifter, My Rifter]\n\nGyrostabilizer II"));
        assert!(!looks_like_dna(""));
        assert!(!looks_like_dna("587:519;1")); // no `::` terminator
    }
}
