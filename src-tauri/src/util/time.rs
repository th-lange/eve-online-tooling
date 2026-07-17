//! Shared time utilities: unix-epoch "now", Howard Hinnant's civil-date
//! conversions, and a minimal UTC RFC3339 parser/formatter.
//!
//! Consolidates what used to be ~16 copies of `SystemTime::now().duration_
//! since(UNIX_EPOCH)…` and 2 duplicated civil-date implementations scattered
//! across modules. Kept dependency-free (no `chrono`) since every caller only
//! ever needed whole-second UTC precision.

use std::time::{SystemTime, UNIX_EPOCH};

/// Seconds since the Unix epoch (UTC). The single source of "now" for the
/// whole crate — callers needing `i64`/`f64` cast at their own call site.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Days since 1970-01-01 for a proleptic-Gregorian date (Howard Hinnant's
/// `days_from_civil`). Avoids pulling in `chrono` for simple date math.
pub fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let (m, d) = (m as i64, d as i64);
    let y = if m <= 2 { y as i64 - 1 } else { y as i64 };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 }; // [0, 11], Mar..Feb
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Days since 1970-01-01 → (year, month, day). Hinnant's `civil_from_days`,
/// the inverse of [`days_from_civil`].
pub fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
}

/// Parse a UTC RFC3339 timestamp (`2026-01-02T03:04:05Z`) to unix epoch
/// seconds. Minimal: date/time only (no fractional seconds or non-`Z`
/// offsets), which is all ESI ever sends.
pub fn parse_rfc3339_epoch(s: &str) -> Result<u64, String> {
    let err = || format!("not an RFC3339 timestamp: {s:?}");
    let bytes = s.as_bytes();
    if s.len() < 19 || bytes.get(4) != Some(&b'-') {
        return Err(err());
    }
    let num = |a: usize, b: usize| s.get(a..b).and_then(|x| x.parse::<i64>().ok());
    let (Some(y), Some(mo), Some(d)) = (num(0, 4), num(5, 7), num(8, 10)) else {
        return Err(err());
    };
    let (Some(h), Some(mi), Some(se)) = (num(11, 13), num(14, 16), num(17, 19)) else {
        return Err(err());
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return Err(err());
    }
    let days = days_from_civil(y as i32, mo as u32, d as u32);
    let secs = days * 86_400 + h * 3_600 + mi * 60 + se;
    Ok(secs.max(0) as u64)
}

/// Format unix epoch seconds as a UTC RFC3339 string (seconds precision,
/// `Z`-suffixed).
pub fn format_rfc3339(secs: u64) -> String {
    let secs = secs as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_secs_is_a_plausible_recent_unix_time() {
        // Sanity floor: 2020-01-01. Guards against a broken clock/overflow,
        // not an exact value.
        assert!(now_secs() > 1_577_836_800);
    }

    #[test]
    fn civil_date_roundtrips_known_epochs() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 1, 1), 10_957);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2021-01-01T00:00:00Z is 18628 days after epoch.
        assert_eq!(civil_from_days(18_628), (2021, 1, 1));
    }

    #[test]
    fn civil_date_roundtrips_are_inverses_across_a_range() {
        for days in [-719_162_i64, -1, 0, 1, 10_957, 18_628, 100_000, 730_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
    }

    #[test]
    fn parses_known_utc_timestamps() {
        assert_eq!(parse_rfc3339_epoch("1970-01-01T00:00:00Z"), Ok(0));
        assert_eq!(parse_rfc3339_epoch("2000-01-01T00:00:00Z"), Ok(946_684_800));
        // Leap day plus a time-of-day, exercising the civil-days algorithm.
        assert_eq!(
            parse_rfc3339_epoch("2024-02-29T12:34:56Z"),
            Ok(1_709_210_096)
        );
    }

    #[test]
    fn later_timestamps_compare_greater() {
        assert!(
            parse_rfc3339_epoch("2026-01-01T00:00:00Z").unwrap()
                > parse_rfc3339_epoch("2025-12-31T23:59:59Z").unwrap()
        );
    }

    #[test]
    fn rejects_garbage_without_panicking() {
        assert!(parse_rfc3339_epoch("nope").is_err());
        assert!(parse_rfc3339_epoch("").is_err());
        assert!(parse_rfc3339_epoch("2024-13-40T00:00:00Z").is_err());
    }

    #[test]
    fn format_and_parse_roundtrip() {
        let secs = 1_709_210_096;
        assert_eq!(parse_rfc3339_epoch(&format_rfc3339(secs)), Ok(secs));
    }
}
