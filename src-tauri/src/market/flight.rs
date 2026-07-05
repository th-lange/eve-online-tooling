//! Single-flight guard: collapse concurrent identical fetches into one
//! upstream request.
//!
//! Callers take the per-key async lock before fetching and re-check their
//! cache once they hold it — the first caller through does the real fetch and
//! fills the cache; everyone who was waiting then finds the cache hit instead
//! of firing a duplicate request (which would waste ESI error budget).

use std::collections::HashMap;
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
}
