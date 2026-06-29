//! Pure rolling-window aggregation: a stream of [`DpsEvent`] → [`DpsTick`].
//!
//! Events are kept in a time-ordered queue. Each tick we drop everything older
//! than `now - window`, sum the surviving amounts per series, and divide by the
//! window length to get a per-second rate — the moving average PyEveLiveDPS
//! shows. Pure and unit-tested; the tail loop owns one [`Window`] and calls
//! [`Window::tick`] on a timer.

use std::collections::VecDeque;

use serde::Serialize;

use super::parser::{DpsEvent, EventKind};

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
        t
    }
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
        }
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
