//! Text helpers shared across services and modules.

/// Truncate `s` in place to at most `max_bytes` bytes, never splitting a
/// UTF-8 character.
///
/// `String::truncate(n)` panics when `n` lands in the middle of a multi-byte
/// character. Untrusted text (user scripts, sandboxed plugins) routinely
/// contains non-ASCII — accented EVE item names, arbitrary unicode in logs —
/// so byte caps must walk back to the previous character boundary instead of
/// panicking. The result is always `<= max_bytes` bytes long.
pub fn truncate_to_char_boundary(s: &mut String, max_bytes: usize) {
    if s.len() <= max_bytes {
        return;
    }
    // Walk back from the cap to the nearest character start. A UTF-8 char is
    // at most 4 bytes, so this loop runs at most 3 times. `is_char_boundary`
    // is true at 0, so `idx` can't underflow.
    let mut idx = max_bytes;
    while !s.is_char_boundary(idx) {
        idx -= 1;
    }
    s.truncate(idx);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a string of the given repeated char that is at least `min_bytes`
    /// bytes long, guaranteeing a char straddles any cap below its length.
    fn repeat_to_at_least(c: char, min_bytes: usize) -> String {
        let mut s = String::new();
        while s.len() < min_bytes {
            s.push(c);
        }
        s
    }

    #[test]
    fn truncates_multibyte_text_straddling_the_cap() {
        // 'é' is 2 bytes in UTF-8; the 2000-byte Info Panel / script-log cap
        // is even, so shift by one ASCII byte to force a char to straddle it.
        for cap in [2000, 8000] {
            let mut s = String::from("x");
            s.push_str(&repeat_to_at_least('é', cap + 8));
            assert!(!s.is_char_boundary(cap), "test must straddle the cap");
            truncate_to_char_boundary(&mut s, cap);
            assert_eq!(s.len(), cap - 1); // backed off one byte to a boundary
            assert!(s.is_char_boundary(s.len()));
        }
    }

    #[test]
    fn truncates_four_byte_chars() {
        // '🚀' is 4 bytes; a 6-byte cap lands mid-char (4 + 4 > 6).
        let mut s = String::from("🚀🚀🚀");
        truncate_to_char_boundary(&mut s, 6);
        assert_eq!(s, "🚀");
    }

    #[test]
    fn leaves_short_and_exact_length_strings_alone() {
        let mut short = String::from("abc");
        truncate_to_char_boundary(&mut short, 10);
        assert_eq!(short, "abc");

        let mut exact = String::from("abcde");
        truncate_to_char_boundary(&mut exact, 5);
        assert_eq!(exact, "abcde");
    }

    #[test]
    fn truncates_ascii_at_the_cap_exactly() {
        let mut s = "a".repeat(20);
        truncate_to_char_boundary(&mut s, 5);
        assert_eq!(s, "aaaaa");
    }

    #[test]
    fn handles_zero_cap() {
        let mut s = String::from("héllo");
        truncate_to_char_boundary(&mut s, 0);
        assert_eq!(s, "");
    }
}
