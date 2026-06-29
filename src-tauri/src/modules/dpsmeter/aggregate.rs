//! Pure rolling-window aggregation: a stream of [`DpsEvent`] → [`DpsTick`].
//!
//! Events are kept in a time-ordered queue. Each tick we drop everything older
//! than `now - window`, sum the surviving amounts per series, and divide by the
//! window length to get a per-second rate — the moving average PyEveLiveDPS
//! shows. Pure and unit-tested; the tail loop owns one [`Window`] and calls
//! [`Window::tick`] on a timer.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;

use super::parser::{DpsEvent, EventKind};

/// How many rows each breakdown table reports (top-N by rate).
const TOP_N: usize = 10;

/// Per-weapon outgoing damage rate (your weapons).
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WeaponRate {
    pub name: String,
    pub dps: f64,
}

/// Per-pilot engagement: damage you dealt to / took from this counterparty.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PilotRate {
    pub name: String,
    pub dps_out: f64,
    pub dps_in: f64,
}

/// A single emitted sample: per-second rates over the current window.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DpsTick {
    pub dps_out: f64,
    pub dps_in: f64,
    pub logi_out: f64,
    pub logi_in: f64,
    pub cap_transfer_out: f64,
    pub cap_transfer_in: f64,
    pub cap_warfare_out: f64,
    pub cap_warfare_in: f64,
    /// Mined volume per second (m³/s) over the window.
    pub mining_m3: f64,
    /// Top weapons by outgoing DPS over the window.
    pub by_weapon: Vec<WeaponRate>,
    /// Top counterparties by total engaged DPS (out + in) over the window.
    pub by_pilot: Vec<PilotRate>,
    /// The averaging window in seconds (echoed so the UI can label the graph).
    pub window_secs: u32,
    /// Epoch seconds this tick was computed at (the graph's x value).
    pub at: i64,
}

/// A time-bounded event buffer producing per-second rates.
pub struct Window {
    secs: i64,
    events: VecDeque<DpsEvent>,
}

impl Window {
    pub fn new(secs: u32) -> Self {
        Self {
            secs: (secs.max(1)) as i64,
            events: VecDeque::new(),
        }
    }

    /// Add a parsed event. Gamelog lines arrive in timestamp order, so we simply
    /// append; out-of-order ticks within a second are harmless to the sums.
    pub fn push(&mut self, ev: DpsEvent) {
        self.events.push_back(ev);
    }

    /// Drop events older than `now - window`, then compute per-second rates.
    pub fn tick(&mut self, now: i64) -> DpsTick {
        let cutoff = now - self.secs;
        while self.events.front().is_some_and(|e| e.ts < cutoff) {
            self.events.pop_front();
        }
        let mut t = DpsTick {
            window_secs: self.secs as u32,
            at: now,
            ..Default::default()
        };
        // Breakdown accumulators: weapon → out-damage; pilot → (out, in).
        let mut weapons: HashMap<&str, f64> = HashMap::new();
        let mut pilots: HashMap<&str, (f64, f64)> = HashMap::new();
        for ev in &self.events {
            let v = ev.amount as f64;
            match ev.kind {
                EventKind::DamageOut => t.dps_out += v,
                EventKind::DamageIn => t.dps_in += v,
                EventKind::RepOut => t.logi_out += v,
                EventKind::RepIn => t.logi_in += v,
                EventKind::CapTransferOut => t.cap_transfer_out += v,
                EventKind::CapTransferIn => t.cap_transfer_in += v,
                EventKind::CapWarfareOut => t.cap_warfare_out += v,
                EventKind::CapWarfareIn => t.cap_warfare_in += v,
                EventKind::Mining => t.mining_m3 += ev.volume,
            }
            // Damage events carry the counterparty + weapon for the breakdowns.
            if ev.kind == EventKind::DamageOut {
                if let Some(w) = ev.weapon.as_deref() {
                    *weapons.entry(w).or_default() += v;
                }
            }
            if let Some(p) = ev.pilot.as_deref() {
                let slot = pilots.entry(p).or_default();
                match ev.kind {
                    EventKind::DamageOut => slot.0 += v,
                    EventKind::DamageIn => slot.1 += v,
                    _ => {}
                }
            }
        }
        let w = self.secs as f64;
        t.dps_out /= w;
        t.dps_in /= w;
        t.logi_out /= w;
        t.logi_in /= w;
        t.cap_transfer_out /= w;
        t.cap_transfer_in /= w;
        t.cap_warfare_out /= w;
        t.cap_warfare_in /= w;
        t.mining_m3 /= w;

        // Rank weapons by DPS and pilots by total engaged DPS; keep the top N.
        t.by_weapon = top_n(
            weapons
                .into_iter()
                .map(|(name, dmg)| WeaponRate {
                    name: name.to_string(),
                    dps: dmg / w,
                }),
            |r| r.dps,
        );
        t.by_pilot = top_n(
            pilots.into_iter().map(|(name, (out, inc))| PilotRate {
                name: name.to_string(),
                dps_out: out / w,
                dps_in: inc / w,
            }),
            |r| r.dps_out + r.dps_in,
        );
        t
    }
}

/// Collect an iterator into the top-[`TOP_N`] rows by `key`, descending.
fn top_n<T>(rows: impl Iterator<Item = T>, key: impl Fn(&T) -> f64) -> Vec<T> {
    let mut v: Vec<T> = rows.collect();
    v.sort_by(|a, b| key(b).partial_cmp(&key(a)).unwrap_or(std::cmp::Ordering::Equal));
    v.truncate(TOP_N);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(ts: i64, kind: EventKind, amount: i64) -> DpsEvent {
        DpsEvent {
            ts,
            kind,
            amount,
            pilot: None,
            ship: None,
            weapon: None,
            ore: None,
            volume: 0.0,
        }
    }

    fn dmg(ts: i64, kind: EventKind, amount: i64, pilot: &str, weapon: &str) -> DpsEvent {
        DpsEvent {
            ts,
            kind,
            amount,
            pilot: Some(pilot.to_string()),
            ship: None,
            weapon: Some(weapon.to_string()),
            ore: None,
            volume: 0.0,
        }
    }

    #[test]
    fn sums_mining_volume_per_second() {
        let mut w = Window::new(10);
        let mut m = ev(1, EventKind::Mining, 100); // units
        m.volume = 50.0; // m³ (set by the loop)
        w.push(m);
        let mut m2 = ev(2, EventKind::Mining, 100);
        m2.volume = 50.0;
        w.push(m2);
        let t = w.tick(5);
        assert_eq!(t.mining_m3, 10.0); // 100 m³ / 10 s
        assert_eq!(t.dps_out, 0.0);
    }

    #[test]
    fn ranks_weapon_and_pilot_breakdowns() {
        let mut w = Window::new(10);
        w.push(dmg(1, EventKind::DamageOut, 600, "Alice", "Autocannon"));
        w.push(dmg(2, EventKind::DamageOut, 400, "Bob", "Autocannon"));
        w.push(dmg(3, EventKind::DamageOut, 200, "Alice", "Drone"));
        w.push(dmg(4, EventKind::DamageIn, 300, "Bob", "Hits"));
        let t = w.tick(5);

        // Weapons ranked by outgoing DPS: Autocannon 1000/10, Drone 200/10.
        assert_eq!(t.by_weapon.len(), 2);
        assert_eq!(t.by_weapon[0].name, "Autocannon");
        assert_eq!(t.by_weapon[0].dps, 100.0);
        assert_eq!(t.by_weapon[1].name, "Drone");

        // Pilots ranked by total engaged DPS: Bob 700/10 > Alice 800/10? Alice
        // dealt 800 out, Bob 400 out + 300 in = 700 → Alice first.
        assert_eq!(t.by_pilot[0].name, "Alice");
        assert_eq!(t.by_pilot[0].dps_out, 80.0);
        assert_eq!(t.by_pilot[0].dps_in, 0.0);
        let bob = t.by_pilot.iter().find(|p| p.name == "Bob").unwrap();
        assert_eq!(bob.dps_out, 40.0);
        assert_eq!(bob.dps_in, 30.0);
    }

    #[test]
    fn averages_over_the_window() {
        let mut w = Window::new(10);
        // 1000 damage dealt across the window → 100 dps over 10s.
        w.push(ev(100, EventKind::DamageOut, 600));
        w.push(ev(105, EventKind::DamageOut, 400));
        let t = w.tick(108);
        assert_eq!(t.dps_out, 100.0);
        assert_eq!(t.dps_in, 0.0);
        assert_eq!(t.window_secs, 10);
        assert_eq!(t.at, 108);
    }

    #[test]
    fn expires_events_outside_the_window() {
        let mut w = Window::new(10);
        w.push(ev(100, EventKind::DamageOut, 1000)); // will age out
        w.push(ev(120, EventKind::DamageOut, 500)); // inside at now=125
        let t = w.tick(125); // cutoff = 115, first event dropped
        assert_eq!(t.dps_out, 50.0);
    }

    #[test]
    fn separates_series() {
        let mut w = Window::new(5);
        w.push(ev(10, EventKind::DamageIn, 250));
        w.push(ev(11, EventKind::RepOut, 100));
        w.push(ev(12, EventKind::CapWarfareOut, 50));
        let t = w.tick(12);
        assert_eq!(t.dps_in, 50.0);
        assert_eq!(t.logi_out, 20.0);
        assert_eq!(t.cap_warfare_out, 10.0);
        assert_eq!(t.dps_out, 0.0);
    }
}
