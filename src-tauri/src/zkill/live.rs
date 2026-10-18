//! Live zKillboard killstream (#924): a persistent websocket connection,
//! shared app-wide, so any feature that wants "who's dying where right now"
//! can read an in-memory rolling index instead of polling zKill's REST
//! endpoints on its own cadence.
//!
//! Subscribes to the `killstream` channel specifically, not the leaner
//! per-entity channels (`faction:X`, `system:X`) — those only push a
//! stripped-down `littlekill` payload with no `solar_system_id` or
//! `faction_id`, which is exactly what our consumers need to bucket kills.
//! `killstream` pushes the full raw killmail (as if from CCP's ESI endpoint)
//! plus zKill's own `zkb` block, so both fields ride along for free.
//!
//! Best-effort, same as the rest of this module: no user-facing error
//! surface, reconnects with capped exponential backoff while anyone is
//! subscribed, and every existing zKill/ESI-kill-count consumer keeps
//! working unmodified if this service is slow to connect or unavailable
//! entirely. The connection is **lazy** (#1060): it only runs while at
//! least one frontend consumer holds a subscription
//! ([`zkill_stream_subscribe`]/[`zkill_stream_unsubscribe`]), and parks —
//! socket closed, no reconnect attempts — within [`IDLE_GRACE_SECS`] of the
//! last one leaving. There is no backfill on connect: the socket only
//! pushes kills observed after subscribing, so callers needing a
//! historical baseline still use the existing REST+cache path.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_tungstenite::tungstenite::Message;

const WS_URL: &str = "wss://zkillboard.com/websocket/";
const SUBSCRIBE_PAYLOAD: &str = r#"{"action":"sub","channel":"killstream"}"#;
const INITIAL_BACKOFF_SECS: u64 = 5;
const MAX_BACKOFF_SECS: u64 = 300;
/// How long the socket stays up after the last subscriber leaves (#1060) —
/// absorbs quick page hops without a disconnect/reconnect churn, while an
/// abandoned stream still winds down promptly.
const IDLE_GRACE_SECS: u64 = 60;
/// How often the read loop checks the subscriber count while connected.
const IDLE_CHECK_SECS: u64 = 5;
/// How far back the in-memory index keeps events — matches the FW hotspots
/// window (#905) so it can serve as a live top-up over that same baseline.
pub const KILL_INDEX_WINDOW_SECS: u64 = 6 * 60 * 60;

/// Hard cap on retained live-kill events, enforced on every [`KillIndex::push`]
/// *in addition to* [`KILL_INDEX_WINDOW_SECS`]'s age-based pruning. Age-based
/// pruning alone trusts every event's self-reported `time_secs` to keep
/// advancing: `KillIndex::prune` only pops from the front while it's older
/// than the cutoff and stops at the first one that isn't, so a single
/// malformed or far-future timestamp from the feed would wedge at the front
/// forever and silently defeat the TTL, growing the index without bound.
/// 20k events is generous headroom over real killstream volume within the
/// 6h window, so this cap should never bind in normal operation — it's a
/// backstop, not the primary eviction policy.
pub const MAX_KILL_INDEX_EVENTS: usize = 20_000;

/// One parsed kill event, reduced to what our consumers need: where it
/// happened and which factions were involved. Deliberately lean — no
/// ship/pod split or entity names, since nothing needs them yet and every
/// added field is one more thing that can fail to parse.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillEvent {
    pub killmail_id: i64,
    pub solar_system_id: i64,
    pub time_secs: u64,
    pub victim_faction_id: Option<i64>,
    pub attacker_faction_ids: Vec<i64>,
    /// The victim's corp/alliance — added for #927 (Local Intel's watchlist
    /// is corp/alliance-scoped, not faction-scoped).
    pub victim_corporation_id: Option<i64>,
    pub victim_alliance_id: Option<i64>,
    /// Deduped, corp/alliance ids of every attacker that has one (NPC/
    /// structure attackers don't).
    pub attacker_corporation_ids: Vec<i64>,
    pub attacker_alliance_ids: Vec<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawVictim {
    #[serde(default)]
    faction_id: Option<i64>,
    #[serde(default)]
    corporation_id: Option<i64>,
    #[serde(default)]
    alliance_id: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawAttacker {
    #[serde(default)]
    faction_id: Option<i64>,
    #[serde(default)]
    corporation_id: Option<i64>,
    #[serde(default)]
    alliance_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RawKillmail {
    killmail_id: i64,
    #[serde(default)]
    killmail_time: String,
    #[serde(default)]
    solar_system_id: i64,
    #[serde(default)]
    victim: RawVictim,
    #[serde(default)]
    attackers: Vec<RawAttacker>,
}

/// Deduped, sorted ids from an iterator, dropping `None`s.
fn deduped_ids(ids: impl Iterator<Item = Option<i64>>) -> Vec<i64> {
    let mut out: Vec<i64> = ids.flatten().collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// Parse one killstream text message into a [`KillEvent`]. Pure — no network,
/// fully unit-testable. Returns `None` for anything that doesn't parse as a
/// killmail (the socket occasionally sends non-kill control frames) or that's
/// missing the fields we need.
pub fn parse_kill_event(raw: &str) -> Option<KillEvent> {
    let km: RawKillmail = serde_json::from_str(raw).ok()?;
    if km.solar_system_id <= 0 {
        return None;
    }
    let time_secs = crate::util::time::parse_rfc3339_epoch(&km.killmail_time).ok()?;
    let attacker_faction_ids = deduped_ids(km.attackers.iter().map(|a| a.faction_id));
    let attacker_corporation_ids = deduped_ids(km.attackers.iter().map(|a| a.corporation_id));
    let attacker_alliance_ids = deduped_ids(km.attackers.iter().map(|a| a.alliance_id));
    Some(KillEvent {
        killmail_id: km.killmail_id,
        solar_system_id: km.solar_system_id,
        time_secs,
        victim_faction_id: km.victim.faction_id,
        attacker_faction_ids,
        victim_corporation_id: km.victim.corporation_id,
        victim_alliance_id: km.victim.alliance_id,
        attacker_corporation_ids,
        attacker_alliance_ids,
    })
}

/// Rolling window of recent kill events, pruned by age on every insert. Not
/// persisted to disk — rebuilds from empty on every app restart.
#[derive(Debug, Default)]
pub struct KillIndex {
    events: VecDeque<KillEvent>,
}

impl KillIndex {
    pub fn push(&mut self, event: KillEvent, now: u64, window_secs: u64, max_events: usize) {
        self.events.push_back(event);
        self.prune(now, window_secs);
        // Backstop against a stuck/defeated age-based prune (see
        // `MAX_KILL_INDEX_EVENTS`) — unconditional, independent of `now`.
        while self.events.len() > max_events {
            self.events.pop_front();
        }
    }

    fn prune(&mut self, now: u64, window_secs: u64) {
        let cutoff = now.saturating_sub(window_secs);
        while let Some(front) = self.events.front() {
            if front.time_secs < cutoff {
                self.events.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// Kill counts per system across the whole retained window.
    pub fn counts_by_system(&self) -> HashMap<i64, i64> {
        let mut m = HashMap::new();
        for e in &self.events {
            *m.entry(e.solar_system_id).or_insert(0) += 1;
        }
        m
    }

    /// `(kills-as-attacker, losses-as-victim)` for one faction, across the
    /// whole retained window.
    pub fn faction_counts(&self, faction_id: i64) -> (i64, i64) {
        let mut kills = 0;
        let mut losses = 0;
        for e in &self.events {
            if e.victim_faction_id == Some(faction_id) {
                losses += 1;
            }
            if e.attacker_faction_ids.contains(&faction_id) {
                kills += 1;
            }
        }
        (kills, losses)
    }

    /// Per-system counts of events matching an arbitrary predicate — the
    /// building block feature-specific consumers (e.g. FW hotspots, #925)
    /// use to bucket live events the same way their REST-based baseline
    /// buckets historical ones.
    pub fn counts_by_system_where(
        &self,
        mut matches: impl FnMut(&KillEvent) -> bool,
    ) -> HashMap<i64, i64> {
        let mut m = HashMap::new();
        for e in &self.events {
            if matches(e) {
                *m.entry(e.solar_system_id).or_insert(0) += 1;
            }
        }
        m
    }
}

/// App-wide managed state: the rolling index, a connectivity flag for the
/// status command, and the subscriber refcount driving the lazy connection
/// (#1060).
#[derive(Default)]
pub struct ZkillStreamState {
    pub index: Mutex<KillIndex>,
    connected: AtomicBool,
    /// Frontend consumers currently holding a subscription. The connection
    /// loop parks while this is zero (after [`IDLE_GRACE_SECS`]).
    consumers: AtomicUsize,
    /// Wakes the parked loop when the count goes 0 → 1.
    wake: tokio::sync::Notify,
}

/// Take a stream lease: the shared killstream runs while at least one lease
/// is held. Frontend features that listen to `zkill://kill` (or read the
/// rolling index) subscribe on mount and [`zkill_stream_unsubscribe`] on
/// unmount. A leaked lease (webview reload mid-session) degrades to the old
/// always-on behavior, never to a missing stream.
#[tauri::command]
pub fn zkill_stream_subscribe(state: State<'_, ZkillStreamState>) {
    state.consumers.fetch_add(1, Ordering::SeqCst);
    state.wake.notify_waiters();
}

/// Release a stream lease (floor at zero — an unmatched unsubscribe from a
/// reloaded webview must not underflow a usize).
#[tauri::command]
pub fn zkill_stream_unsubscribe(state: State<'_, ZkillStreamState>) {
    let _ = state
        .consumers
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
}

/// Park until at least one subscriber exists. The `notified()` future is
/// armed *before* the re-check, so a subscribe landing between the check and
/// the await can't be missed.
async fn wait_for_consumers(state: &ZkillStreamState) {
    loop {
        if state.consumers.load(Ordering::SeqCst) > 0 {
            return;
        }
        let notified = state.wake.notified();
        if state.consumers.load(Ordering::SeqCst) > 0 {
            return;
        }
        notified.await;
    }
}

/// Why [`run_once`] returned: the peer closed cleanly, or the stream wound
/// itself down because nobody was subscribed for [`IDLE_GRACE_SECS`].
enum StreamEnd {
    Disconnected,
    Idle,
}

/// Spawn the background connection loop. Call once, from app setup — never
/// fatal to launch. Parks while no consumer is subscribed (#1060); while
/// subscribed, retries with capped exponential backoff on any
/// connect/parse/disconnect error.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = INITIAL_BACKOFF_SECS;
        loop {
            if let Some(state) = app.try_state::<ZkillStreamState>() {
                wait_for_consumers(&state).await;
            }
            match run_once(&app).await {
                // Clean disconnect or idle wind-down — reset the backoff.
                Ok(StreamEnd::Disconnected) | Ok(StreamEnd::Idle) => {
                    backoff = INITIAL_BACKOFF_SECS;
                }
                Err(_e) => {
                    // Best-effort: no user-facing error surface, matches the
                    // rest of the zkill module's `Option`-returning discipline.
                }
            }
            if let Some(state) = app.try_state::<ZkillStreamState>() {
                state.connected.store(false, Ordering::Relaxed);
            }
            tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
        }
    });
}

async fn run_once(app: &AppHandle) -> Result<StreamEnd, String> {
    let (ws_stream, _) = tokio_tungstenite::connect_async(WS_URL)
        .await
        .map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws_stream.split();
    write
        .send(Message::Text(SUBSCRIBE_PAYLOAD.into()))
        .await
        .map_err(|e| e.to_string())?;

    if let Some(state) = app.try_state::<ZkillStreamState>() {
        state.connected.store(true, Ordering::Relaxed);
    }

    // Wind down once nobody has been subscribed for IDLE_GRACE_SECS (#1060):
    // checked on a slow side-tick so a dead-quiet socket (no messages to
    // react to) still notices its consumers left.
    let mut idle_check = tokio::time::interval(std::time::Duration::from_secs(IDLE_CHECK_SECS));
    let mut idle_since: Option<std::time::Instant> = None;
    loop {
        tokio::select! {
            msg = read.next() => {
                let Some(msg) = msg else {
                    return Ok(StreamEnd::Disconnected);
                };
                let msg = msg.map_err(|e| e.to_string())?;
                let Message::Text(text) = msg else { continue };
                let Some(event) = parse_kill_event(&text) else {
                    continue;
                };
                if let Some(state) = app.try_state::<ZkillStreamState>() {
                    let now = crate::util::time::now_secs();
                    state.index.lock().push(
                        event.clone(),
                        now,
                        KILL_INDEX_WINDOW_SECS,
                        MAX_KILL_INDEX_EVENTS,
                    );
                }
                let _ = app.emit("zkill://kill", &event);
            }
            _ = idle_check.tick() => {
                let subscribed = app
                    .try_state::<ZkillStreamState>()
                    .is_some_and(|s| s.consumers.load(Ordering::SeqCst) > 0);
                if subscribed {
                    idle_since = None;
                } else {
                    let since = idle_since.get_or_insert_with(std::time::Instant::now);
                    if since.elapsed().as_secs() >= IDLE_GRACE_SECS {
                        return Ok(StreamEnd::Idle);
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZkillStreamStatus {
    pub connected: bool,
    pub event_count: usize,
    pub window_secs: u64,
}

/// Connectivity + index size, for a status indicator or debugging — not the
/// per-system/per-faction breakdown, which each consumer feature will expose
/// through its own command shaped around what it actually needs.
#[tauri::command]
pub fn zkill_stream_status(state: State<'_, ZkillStreamState>) -> ZkillStreamStatus {
    let idx = state.index.lock();
    ZkillStreamStatus {
        connected: state.connected.load(Ordering::Relaxed),
        event_count: idx.len(),
        window_secs: KILL_INDEX_WINDOW_SECS,
    }
}

/// Live kill counts per solar system across the retained window — the
/// universe-wide signal `#928` (Route/Local Intel) and any other consumer
/// wanting "kills near system X" without a per-faction filter can use
/// directly.
#[tauri::command]
pub fn zkill_stream_system_counts(state: State<'_, ZkillStreamState>) -> HashMap<String, i64> {
    state
        .index
        .lock()
        .counts_by_system()
        .into_iter()
        .map(|(id, n)| (id.to_string(), n))
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZkillStreamFactionCounts {
    pub kills: i64,
    pub losses: i64,
}

/// Live `(kills-as-attacker, losses-as-victim)` for one faction across the
/// retained window — the per-faction signal `#925` (FW hotspots) and `#926`
/// (FW home-defense) will build on.
#[tauri::command]
pub fn zkill_stream_faction_counts(
    state: State<'_, ZkillStreamState>,
    faction_id: i64,
) -> ZkillStreamFactionCounts {
    let (kills, losses) = state.index.lock().faction_counts(faction_id);
    ZkillStreamFactionCounts { kills, losses }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn km_json(
        system_id: i64,
        time: &str,
        victim_faction: Option<i64>,
        attacker_factions: &[i64],
    ) -> String {
        let attackers: Vec<String> = attacker_factions
            .iter()
            .map(|f| format!(r#"{{"faction_id":{f}}}"#))
            .collect();
        let victim = match victim_faction {
            Some(f) => format!(r#"{{"faction_id":{f}}}"#),
            None => "{}".to_string(),
        };
        format!(
            r#"{{"killmail_id":1,"killmail_time":"{time}","solar_system_id":{system_id},"victim":{victim},"attackers":[{}]}}"#,
            attackers.join(",")
        )
    }

    #[test]
    fn unsubscribe_floors_at_zero_and_subscribe_counts_up() {
        let state = ZkillStreamState::default();
        // An unmatched unsubscribe (reloaded webview) must not underflow.
        let _ = state
            .consumers
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
        assert_eq!(state.consumers.load(Ordering::SeqCst), 0);
        state.consumers.fetch_add(1, Ordering::SeqCst);
        assert_eq!(state.consumers.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn wait_for_consumers_parks_until_a_subscriber_arrives() {
        use std::sync::Arc;
        let state = Arc::new(ZkillStreamState::default());

        // No subscribers: the wait must still be pending after a beat.
        let waiter = {
            let state = state.clone();
            tokio::spawn(async move { wait_for_consumers(&state).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiter.is_finished(), "parked loop woke without consumers");

        // First subscriber arrives → the parked loop wakes.
        state.consumers.fetch_add(1, Ordering::SeqCst);
        state.wake.notify_waiters();
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("waiter woke after subscribe")
            .expect("waiter task");
    }

    #[test]
    fn parses_a_full_killmail_into_a_kill_event() {
        let raw = km_json(
            30002813,
            "2026-01-02T03:04:05Z",
            Some(500003),
            &[500002, 500002],
        );
        let event = parse_kill_event(&raw).expect("should parse");
        assert_eq!(event.killmail_id, 1);
        assert_eq!(event.solar_system_id, 30002813);
        assert_eq!(event.victim_faction_id, Some(500003));
        // Deduped even though the raw mail listed the attacker faction twice.
        assert_eq!(event.attacker_faction_ids, vec![500002]);
    }

    #[test]
    fn parses_victim_and_attacker_corp_alliance_ids() {
        let raw = r#"{
            "killmail_id": 2,
            "killmail_time": "2026-01-02T03:04:05Z",
            "solar_system_id": 30002813,
            "victim": {"corporation_id": 98000001, "alliance_id": 99000001},
            "attackers": [
                {"corporation_id": 98000002, "alliance_id": 99000002},
                {"corporation_id": 98000002},
                {"character_id": 123456}
            ]
        }"#;
        let event = parse_kill_event(raw).expect("should parse");
        assert_eq!(event.victim_corporation_id, Some(98000001));
        assert_eq!(event.victim_alliance_id, Some(99000001));
        // Deduped: two attackers share corp 98000002.
        assert_eq!(event.attacker_corporation_ids, vec![98000002]);
        assert_eq!(event.attacker_alliance_ids, vec![99000002]);
    }

    #[test]
    fn returns_none_for_malformed_or_non_killmail_messages() {
        assert!(parse_kill_event("not json").is_none());
        assert!(parse_kill_event(r#"{"action":"pong"}"#).is_none());
    }

    #[test]
    fn returns_none_without_a_valid_system_id() {
        let raw = km_json(0, "2026-01-02T03:04:05Z", None, &[]);
        assert!(parse_kill_event(&raw).is_none());
    }

    #[test]
    fn index_counts_kills_per_system() {
        let mut idx = KillIndex::default();
        idx.push(
            parse_kill_event(&km_json(1, "2026-01-01T00:00:00Z", None, &[])).unwrap(),
            86_400,
            KILL_INDEX_WINDOW_SECS,
            MAX_KILL_INDEX_EVENTS,
        );
        idx.push(
            parse_kill_event(&km_json(1, "2026-01-01T00:00:01Z", None, &[])).unwrap(),
            86_400,
            KILL_INDEX_WINDOW_SECS,
            MAX_KILL_INDEX_EVENTS,
        );
        idx.push(
            parse_kill_event(&km_json(2, "2026-01-01T00:00:02Z", None, &[])).unwrap(),
            86_400,
            KILL_INDEX_WINDOW_SECS,
            MAX_KILL_INDEX_EVENTS,
        );
        let counts = idx.counts_by_system();
        assert_eq!(counts[&1], 2);
        assert_eq!(counts[&2], 1);
    }

    #[test]
    fn index_prunes_events_older_than_the_window() {
        let mut idx = KillIndex::default();
        // now = 100_000; window = 10; event at t=0 is well outside it.
        idx.push(
            parse_kill_event(&km_json(1, "1970-01-01T00:00:00Z", None, &[])).unwrap(),
            0,
            10,
            MAX_KILL_INDEX_EVENTS,
        );
        assert_eq!(idx.len(), 1);
        idx.push(
            parse_kill_event(&km_json(2, "1970-01-01T00:00:00Z", None, &[])).unwrap(),
            100_000,
            10,
            MAX_KILL_INDEX_EVENTS,
        );
        // The push itself re-prunes against `now = 100_000` — both the old
        // event (t=0) and this new one (also t=0, same fixture) fall outside
        // a 10s window from 100_000, so the index ends up empty.
        assert_eq!(idx.len(), 0);
    }

    #[test]
    fn faction_counts_splits_kills_from_losses() {
        let mut idx = KillIndex::default();
        // Faction 500003 loses this one (victim)...
        idx.push(
            parse_kill_event(&km_json(1, "2026-01-01T00:00:00Z", Some(500003), &[500002])).unwrap(),
            86_400,
            KILL_INDEX_WINDOW_SECS,
            MAX_KILL_INDEX_EVENTS,
        );
        // ...and gets a kill on this one (attacker).
        idx.push(
            parse_kill_event(&km_json(2, "2026-01-01T00:00:01Z", Some(500002), &[500003])).unwrap(),
            86_400,
            KILL_INDEX_WINDOW_SECS,
            MAX_KILL_INDEX_EVENTS,
        );
        let (kills, losses) = idx.faction_counts(500003);
        assert_eq!(kills, 1);
        assert_eq!(losses, 1);
    }

    #[test]
    fn empty_index_reports_zero_counts() {
        let idx = KillIndex::default();
        assert_eq!(idx.len(), 0);
        assert!(idx.counts_by_system().is_empty());
        assert_eq!(idx.faction_counts(500001), (0, 0));
    }

    #[test]
    fn index_stays_bounded_by_the_max_events_cap_even_when_age_pruning_cannot_help() {
        let mut idx = KillIndex::default();
        // Every event shares the same `now`/`time_secs`, so age-based pruning
        // (`window_secs`) never kicks in — this isolates the hard size cap as
        // the only thing keeping the index bounded, mirroring the real-world
        // failure mode of a feed event wedged at the front with a timestamp
        // that never ages out.
        let cap = 5;
        for i in 1..=(cap as i64 * 3) {
            idx.push(
                parse_kill_event(&km_json(i, "2026-01-01T00:00:00Z", None, &[])).unwrap(),
                86_400,
                KILL_INDEX_WINDOW_SECS,
                cap,
            );
        }
        assert_eq!(
            idx.len(),
            cap,
            "index must never exceed the configured max_events cap"
        );
    }
}
