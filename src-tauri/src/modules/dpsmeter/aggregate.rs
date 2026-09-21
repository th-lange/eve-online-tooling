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

/// A weapon/ammo/drone damage row. `kind` is the source type (the ammo/drone's
/// SDE group, e.g. "Rocket", "Hybrid Charge", "Light Scout Drone"); `damage` is
/// the ammo's dominant damage type(s) (e.g. "Kin", "EM/Th"). Both are filled in
/// by the command layer from the SDE — the combat log names only the ammo, not
/// the weapon module or the damage type.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WeaponRate {
    pub name: String,
    pub dps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub damage: Option<String>,
}

/// Per-pilot engagement: damage you dealt to / took from this counterparty.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PilotRate {
    pub name: String,
    pub dps_out: f64,
    pub dps_in: f64,
    /// Ship the attacker is flying, parsed from `(SHIP)` in the combat log.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ship: Option<String>,
    /// Per-source damage you dealt to them (outgoing), each with its dps.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub weapons_out: Vec<WeaponRate>,
    /// Per-source damage they dealt to you (incoming; the source is named only
    /// for player attackers — EVE never names an NPC's weapon).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub weapons_in: Vec<WeaponRate>,
    /// Hit-quality tally of your hits on them.
    #[serde(default)]
    pub quality_out: HitQuality,
    /// Hit-quality tally of their hits on you.
    #[serde(default)]
    pub quality_in: HitQuality,
    /// Tackle you're applying to them within the window.
    #[serde(default)]
    pub scram_out: bool,
    #[serde(default)]
    pub point_out: bool,
    /// Tackle they're applying to you within the window.
    #[serde(default)]
    pub scram_in: bool,
    #[serde(default)]
    pub point_in: bool,
}

/// Counts of each hit-quality tier within the window, worst→best:
/// misses, glances off, grazes, hits, penetrates, smashes, wrecks (from the
/// gamelog's quality suffix; misses come from the separate miss lines).
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HitQuality {
    pub misses: i64,
    pub glances: i64,
    pub grazes: i64,
    pub hits: i64,
    pub penetrates: i64,
    pub smashes: i64,
    pub wrecks: i64,
}

impl HitQuality {
    fn count(&mut self, quality: Option<&str>) {
        let Some(q) = quality else { return };
        if q.eq_ignore_ascii_case("misses") {
            self.misses += 1;
        } else if q.eq_ignore_ascii_case("glances off") {
            self.glances += 1;
        } else if q.eq_ignore_ascii_case("grazes") {
            self.grazes += 1;
        } else if q.eq_ignore_ascii_case("hits") {
            self.hits += 1;
        } else if q.eq_ignore_ascii_case("penetrates") {
            self.penetrates += 1;
        } else if q.eq_ignore_ascii_case("smashes") {
            self.smashes += 1;
        } else if q.eq_ignore_ascii_case("wrecks") {
            self.wrecks += 1;
        }
    }
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
    /// High-quality outgoing hits within the window.
    pub hits_out: HitQuality,
    /// High-quality incoming hits within the window.
    pub hits_in: HitQuality,
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
    /// The eviction cutoff computed by the most recent `tick`. `tick` clamps
    /// each new cutoff to never regress below this, so a backward `now` (an
    /// OS clock adjustment during a live session, or an out-of-order
    /// timestamp from a malformed/replayed log) can't stop eviction and leak
    /// the buffer for the rest of the session (#817). Starts at `i64::MIN` so
    /// the very first tick is unclamped.
    last_cutoff: i64,
}

impl Window {
    pub fn new(secs: u32) -> Self {
        Self {
            secs: (secs.max(1)) as i64,
            events: VecDeque::new(),
            last_cutoff: i64::MIN,
        }
    }

    /// Add a parsed event. Gamelog lines arrive in timestamp order, so we simply
    /// append; out-of-order ticks within a second are harmless to the sums.
    pub fn push(&mut self, ev: DpsEvent) {
        self.events.push_back(ev);
    }

    /// Drop events older than `now - window`, then compute per-second rates.
    /// The cutoff is clamped to never regress (#817): if `now` moves
    /// backward, we hold the last cutoff instead of un-evicting the window.
    pub fn tick(&mut self, now: i64) -> DpsTick {
        let cutoff = (now - self.secs).max(self.last_cutoff);
        self.last_cutoff = cutoff;
        while self.events.front().is_some_and(|e| e.ts < cutoff) {
            self.events.pop_front();
        }
        let mut t = DpsTick {
            window_secs: self.secs as u32,
            at: now,
            ..Default::default()
        };
        // Breakdown accumulators: weapon → out-damage; pilot → engagement.
        #[derive(Default)]
        struct PilotAcc<'a> {
            out: f64,
            inc: f64,
            ship: Option<&'a str>,
            weapons_out: HashMap<&'a str, f64>,
            weapons_in: HashMap<&'a str, f64>,
            quality_out: HitQuality,
            quality_in: HitQuality,
            scram_out: bool,
            point_out: bool,
            scram_in: bool,
            point_in: bool,
        }
        let mut weapons: HashMap<&str, f64> = HashMap::new();
        let mut pilots: HashMap<&str, PilotAcc> = HashMap::new();
        for ev in &self.events {
            let v = ev.amount as f64;
            match ev.kind {
                EventKind::DamageOut => {
                    t.dps_out += v;
                    t.hits_out.count(ev.quality.as_deref());
                }
                EventKind::DamageIn => {
                    t.dps_in += v;
                    t.hits_in.count(ev.quality.as_deref());
                }
                EventKind::RepOut => t.logi_out += v,
                EventKind::RepIn => t.logi_in += v,
                EventKind::CapTransferOut => t.cap_transfer_out += v,
                EventKind::CapTransferIn => t.cap_transfer_in += v,
                EventKind::CapWarfareOut => t.cap_warfare_out += v,
                EventKind::CapWarfareIn => t.cap_warfare_in += v,
                EventKind::Mining => t.mining_m3 += ev.volume,
                // Tackle is a per-pilot state flag, not a rate — no tick sum.
                EventKind::ScramOut
                | EventKind::ScramIn
                | EventKind::PointOut
                | EventKind::PointIn => {}
            }
            // Global "damage by weapon" — your outgoing weapons only.
            if ev.kind == EventKind::DamageOut {
                if let Some(w) = ev.weapon.as_deref() {
                    *weapons.entry(w).or_default() += v;
                }
            }
            if let Some(p) = ev.pilot.as_deref() {
                let slot = pilots.entry(p).or_default();
                let weapon = ev.weapon.as_deref();
                match ev.kind {
                    EventKind::DamageOut => {
                        slot.out += v;
                        slot.quality_out.count(ev.quality.as_deref());
                        if let Some(w) = weapon {
                            *slot.weapons_out.entry(w).or_default() += v;
                        }
                    }
                    EventKind::DamageIn => {
                        slot.inc += v;
                        slot.quality_in.count(ev.quality.as_deref());
                        if let Some(w) = weapon {
                            *slot.weapons_in.entry(w).or_default() += v;
                        }
                        // Capture attacker's ship (keep most-recent).
                        if ev.ship.is_some() {
                            slot.ship = ev.ship.as_deref();
                        }
                    }
                    EventKind::ScramOut => slot.scram_out = true,
                    EventKind::PointOut => slot.point_out = true,
                    EventKind::ScramIn => slot.scram_in = true,
                    EventKind::PointIn => slot.point_in = true,
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
            weapons.into_iter().map(|(name, dmg)| WeaponRate {
                name: name.to_string(),
                dps: dmg / w,
                kind: None,
                damage: None,
            }),
            |r| r.dps,
        );
        t.by_pilot = top_n(
            pilots.into_iter().map(|(name, acc)| PilotRate {
                name: name.to_string(),
                dps_out: acc.out / w,
                dps_in: acc.inc / w,
                ship: acc.ship.map(String::from),
                weapons_out: weapon_rates(acc.weapons_out, w),
                weapons_in: weapon_rates(acc.weapons_in, w),
                quality_out: acc.quality_out,
                quality_in: acc.quality_in,
                scram_out: acc.scram_out,
                point_out: acc.point_out,
                scram_in: acc.scram_in,
                point_in: acc.point_in,
            }),
            |r| r.dps_out + r.dps_in,
        );
        t
    }
}

/// Collect an iterator into the top-[`TOP_N`] rows by `key`, descending.
fn top_n<T>(rows: impl Iterator<Item = T>, key: impl Fn(&T) -> f64) -> Vec<T> {
    let mut v: Vec<T> = rows.collect();
    v.sort_by(|a, b| {
        key(b)
            .partial_cmp(&key(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    v.truncate(TOP_N);
    v
}

/// Build a per-source damage list (name + dps) sorted by dps descending.
/// `kind`/`damage` are filled later by the command layer from the SDE.
fn weapon_rates(map: HashMap<&str, f64>, window: f64) -> Vec<WeaponRate> {
    let mut v: Vec<WeaponRate> = map
        .into_iter()
        .map(|(name, dmg)| WeaponRate {
            name: name.to_string(),
            dps: dmg / window,
            kind: None,
            damage: None,
        })
        .collect();
    v.sort_by(|a, b| {
        b.dps
            .partial_cmp(&a.dps)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
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
            quality: None,
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
            quality: None,
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

    #[test]
    fn eviction_cutoff_is_monotonic_across_a_backward_clock_step() {
        // #817: a backward `now` (OS clock adjustment during a live session,
        // or an out-of-order playback timestamp) must not stop eviction and
        // leak the buffer for the rest of the session.
        let mut w = Window::new(10);
        for ts in 0..50 {
            w.push(ev(ts, EventKind::DamageOut, 1));
        }
        assert_eq!(w.events.len(), 50);

        // Tick forward: evicts everything older than `now - secs`.
        w.tick(40);
        assert_eq!(w.events.len(), 20); // ts 30..=49 survive (cutoff = 30)

        // Clock regresses. A naive `now - secs` cutoff would go backward to
        // -5 and stop evicting for the rest of the session; the clamped
        // cutoff holds at 30, so pushing more events doesn't let the window
        // grow unboundedly just because `now` briefly moved backward.
        for ts in 50..60 {
            w.push(ev(ts, EventKind::DamageOut, 1));
        }
        w.tick(5);
        assert_eq!(w.events.len(), 30); // 20 old + 10 new, still bounded

        // Tick forward again: eviction resumes and catches up past the
        // clamped cutoff.
        w.tick(65);
        assert_eq!(w.events.len(), 5); // ts 55..=59 survive (cutoff = 55)
    }

    #[test]
    fn tallies_per_pilot_quality_and_misses_without_moving_dps() {
        let q = |ts, kind, amount, pilot: &str, quality: &str| DpsEvent {
            ts,
            kind,
            amount,
            pilot: Some(pilot.to_string()),
            ship: None,
            weapon: None,
            quality: Some(quality.to_string()),
            ore: None,
            volume: 0.0,
        };
        let mut w = Window::new(10);
        w.push(q(1, EventKind::DamageOut, 100, "Rat", "Smashes"));
        w.push(q(2, EventKind::DamageOut, 50, "Rat", "Grazes"));
        w.push(q(3, EventKind::DamageOut, 0, "Rat", "Misses")); // zero-amount miss
        w.push(q(4, EventKind::DamageIn, 30, "Rat", "Penetrates"));
        let t = w.tick(5);

        // The miss adds no damage but is tallied.
        assert_eq!(t.dps_out, 15.0); // (100 + 50 + 0) / 10
        let rat = t.by_pilot.iter().find(|p| p.name == "Rat").unwrap();
        assert_eq!(rat.quality_out.smashes, 1);
        assert_eq!(rat.quality_out.grazes, 1);
        assert_eq!(rat.quality_out.misses, 1);
        assert_eq!(rat.quality_in.penetrates, 1);
        // Global tallies mirror the per-pilot ones.
        assert_eq!(t.hits_out.misses, 1);
        assert_eq!(t.hits_out.smashes, 1);
    }
}
