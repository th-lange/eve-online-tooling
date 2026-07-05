//! Shared EVE chatlog reading + parsing.
//!
//! EVE writes chatlogs as UTF-16LE with a BOM; message lines look like
//! `[ 2026.06.25 12:00:00 ] Sender Name > text`. Used by the Local Intel
//! module (who spoke in Local) and the Shopping module's chat capture (which
//! items were linked in a channel).

use std::collections::HashSet;

/// Read an EVE chatlog file, decoding UTF-16LE (the format EVE writes) or UTF-8.
pub fn read_chatlog(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        // UTF-16LE with BOM.
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        Some(String::from_utf16_lossy(&u16s))
    } else {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// Distinct sender names from chatlog content, in order of first appearance.
/// The member list isn't logged, so this only yields pilots who actually
/// spoke; `EVE System` lines are skipped. Pure (testable).
pub fn parse_chat_senders(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in content.lines() {
        let Some((_, after)) = line.split_once("] ") else {
            continue;
        };
        let Some((sender, _msg)) = after.split_once(" > ") else {
            continue;
        };
        let s = sender.trim();
        if s.is_empty() || s == "EVE System" {
            continue;
        }
        if seen.insert(s.to_string()) {
            out.push(s.to_string());
        }
    }
    out
}

/// Longest message we keep (chat text is untrusted input — bound the memory a
/// hostile paste can occupy).
const MAX_MESSAGE_LEN: usize = 10_000;

/// The message text of each chat entry, in order. A message that contains
/// linebreaks (a multi-line paste) is logged as one header line
/// (`[ ts ] Sender > first line`) followed by bare continuation lines — those
/// are re-joined onto their message here. System lines and empty messages are
/// skipped. Pure (testable).
pub fn parse_chat_messages(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // Whether the previous header line was a (kept) player message, so bare
    // continuation lines know where they belong.
    let mut in_message = false;
    for line in content.lines() {
        // Header lines look like `[ 2026.06.25 12:00:00 ] Sender > text`.
        let header = line
            .starts_with('[')
            .then(|| line.split_once("] "))
            .flatten()
            .and_then(|(_, after)| after.split_once(" > "));
        match header {
            Some((sender, msg)) => {
                if sender.trim() == "EVE System" {
                    in_message = false;
                } else {
                    out.push(msg.trim().to_string());
                    in_message = true;
                }
            }
            None => {
                // Continuation of the previous message (multi-line paste).
                if in_message {
                    if let Some(last) = out.last_mut() {
                        if last.len() + line.len() < MAX_MESSAGE_LEN {
                            last.push('\n');
                            last.push_str(line.trim());
                        }
                    }
                }
            }
        }
    }
    out.retain(|m| !m.trim().is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = "\
[ 2026.06.25 12:00:00 ] EVE System > Channel MOTD: hi
[ 2026.06.25 12:00:05 ] Alice Pilot > Tritanium
[ 2026.06.25 12:00:06 ] Bob Pilot > Pyerite
[ 2026.06.25 12:00:07 ] Alice Pilot > o7
[ 2026.06.25 12:00:08 ] Bob Pilot >   ";

    #[test]
    fn parses_senders_in_order_deduped() {
        assert_eq!(parse_chat_senders(LOG), vec!["Alice Pilot", "Bob Pilot"]);
    }

    #[test]
    fn parses_messages_and_skips_system_and_empty_lines() {
        assert_eq!(parse_chat_messages(LOG), vec!["Tritanium", "Pyerite", "o7"]);
    }

    #[test]
    fn rejoins_multiline_pastes_onto_their_message() {
        let log = "\
[ 2026.06.25 12:00:00 ] EVE System > MOTD
ignored continuation of a system line
[ 2026.06.25 12:00:05 ] Alice Pilot > Tritanium 100
Pyerite 50
Mexallon
[ 2026.06.25 12:00:09 ] Bob Pilot > o7";
        assert_eq!(
            parse_chat_messages(log),
            vec!["Tritanium 100\nPyerite 50\nMexallon", "o7"]
        );
    }
}
