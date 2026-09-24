//! Single-flight guard: collapse concurrent identical fetches into one
//! upstream request.
//!
//! Callers take the per-key async lock before fetching and re-check their
//! cache once they hold it — the first caller through does the real fetch and
//! fills the cache; everyone who was waiting then finds the cache hit instead
//! of firing a duplicate request (which would waste ESI error budget).

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

/// One async lock per key. The map only grows with distinct keys ever
/// requested (same boundedness as the TTL caches it guards) and each entry is
/// a couple of pointers, so no eviction is needed.
pub struct KeyLocks<K> {
    locks: Mutex<HashMap<K, Arc<AsyncMutex<()>>>>,
}

impl<K: Eq + Hash + Clone> KeyLocks<K> {
    pub fn new() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
        }
    }

    /// The lock for `key` (created on first use). Hold it across the
    /// cache-recheck + fetch + cache-fill sequence.
    pub fn lock_for(&self, key: &K) -> Arc<AsyncMutex<()>> {
        self.locks
            .lock()
            .expect("key-lock map poisoned")
            .entry(key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

impl<K: Eq + Hash + Clone> Default for KeyLocks<K> {
    fn default() -> Self {
        Self::new()
    }
}

/// Same as [`deduplicated_cached_fetch_with_stale_fallback`], but with no
/// stale-fallback: a fetch failure always propagates unchanged. The common
/// case for caches that have no bounded-stale story (most of them).
///
/// `check_cache` is `FnMut` (not `Fn`) so a caller assembling a partial
/// result across multiple keys (e.g. a batch of misses) can mutate captured
/// state on each cache probe.
pub async fn deduplicated_cached_fetch<K, V, E, C, F, Fut>(
    locks: &KeyLocks<K>,
    key: &K,
    check_cache: C,
    fetch: F,
) -> Result<V, E>
where
    K: Eq + Hash + Clone,
    C: FnMut() -> Option<V>,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<V, E>>,
{
    deduplicated_cached_fetch_with_stale_fallback(locks, key, check_cache, fetch, || None).await
}

/// The single-flight + TTL "lock-gate → check-cache → fetch" pattern, with an
/// optional bounded-stale fallback: when `fetch` fails, `stale_fallback` gets
/// one last chance to serve a value (e.g. a disk-backed cache entry read
/// within a bounded staleness window) instead of propagating the error.
/// Generalizes the pattern production's system cost index established for
/// its own bespoke cache (#774) so any `deduplicated_cached_fetch` caller can
/// opt in: a stale success beats a hard error (#888).
///
/// 1. Check the cache; return immediately on a hit.
/// 2. Take this key's lock (queueing behind any concurrent identical fetch).
/// 3. Re-check the cache — the caller that was fetching may have just filled
///    it, in which case this is now a cache hit too.
/// 4. Otherwise, run `fetch`. On success, return it. On failure, try
///    `stale_fallback`; a hit returns its value, a miss propagates the
///    original fetch error.
pub async fn deduplicated_cached_fetch_with_stale_fallback<K, V, E, C, F, Fut, S>(
    locks: &KeyLocks<K>,
    key: &K,
    mut check_cache: C,
    fetch: F,
    stale_fallback: S,
) -> Result<V, E>
where
    K: Eq + Hash + Clone,
    C: FnMut() -> Option<V>,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<V, E>>,
    S: FnOnce() -> Option<V>,
{
    if let Some(cached) = check_cache() {
        return Ok(cached);
    }
    let gate = locks.lock_for(key);
    let _flight = gate.lock().await;
    if let Some(cached) = check_cache() {
        return Ok(cached);
    }
    match fetch().await {
        Ok(value) => Ok(value),
        Err(err) => stale_fallback().ok_or(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Eight concurrent "callers" for the same key must produce one fetch:
    /// the first takes the lock and fetches (yielding mid-flight, as a real
    /// network await would); the rest wait, then see the filled cache.
    #[test]
    fn concurrent_identical_requests_fetch_once() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        rt.block_on(async {
            let locks = Arc::new(KeyLocks::<i64>::new());
            let cache = Arc::new(Mutex::new(Option::<&'static str>::None));
            let fetches = Arc::new(AtomicUsize::new(0));

            let mut tasks = Vec::new();
            for _ in 0..8 {
                let (locks, cache, fetches) = (locks.clone(), cache.clone(), fetches.clone());
                tasks.push(tokio::spawn(async move {
                    let gate = locks.lock_for(&42);
                    let _flight = gate.lock().await;
                    if cache.lock().unwrap().is_some() {
                        return; // cache hit after waiting — no duplicate fetch
                    }
                    fetches.fetch_add(1, Ordering::SeqCst);
                    tokio::task::yield_now().await; // simulate the network await
                    *cache.lock().unwrap() = Some("data");
                }));
            }
            for t in tasks {
                t.await.unwrap();
            }
            assert_eq!(fetches.load(Ordering::SeqCst), 1);
        });
    }

    /// Expired-but-recoverable cache + failing fetch → the stale fallback is
    /// served instead of the error (moved/adapted from production's
    /// `cost_index_fallback_tests`, #774/#888).
    #[test]
    fn stale_fallback_beats_fetch_error() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        rt.block_on(async {
            let locks = KeyLocks::<i64>::new();
            let got: Result<HashMap<i64, f64>, String> =
                deduplicated_cached_fetch_with_stale_fallback(
                    &locks,
                    &42,
                    || None,
                    || async { Err::<HashMap<i64, f64>, String>("esi down".into()) },
                    || Some([(30000142, 0.041)].into()),
                )
                .await;
            assert_eq!(got.unwrap(), [(30000142, 0.041)].into());
        });
    }

    /// No usable stale fallback + failing fetch → the fetch error surfaces
    /// unchanged.
    #[test]
    fn no_stale_fallback_surfaces_the_error() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        rt.block_on(async {
            let locks = KeyLocks::<i64>::new();
            let got: Result<HashMap<i64, f64>, String> =
                deduplicated_cached_fetch_with_stale_fallback(
                    &locks,
                    &42,
                    || None,
                    || async { Err::<HashMap<i64, f64>, String>("esi down".into()) },
                    || None,
                )
                .await;
            assert_eq!(got.unwrap_err(), "esi down");
        });
    }
}
