//! A tiny thread-safe TTL cache, used to honor ESI cache timers (orders ~5 min,
//! history ~daily, global prices ~hourly) so repeated profit calculations don't
//! refetch.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

pub struct TtlCache<K, V> {
    map: Mutex<HashMap<K, (Instant, V)>>,
    ttl: Duration,
}

/// Lock the cache's map, recovering from poison instead of panicking.
///
/// The guarded data is just cached price/order entries: if some other lookup
/// panicked while holding this lock, the map is still a perfectly usable
/// `HashMap` — a recovered guard just sees whatever was last written. `get`
/// already treats a missing/expired entry as an ordinary cache miss, so the
/// worst outcome of recovering here is one extra upstream refetch, not a
/// crash that takes down every subsequent market lookup on this cache.
fn recover_lock<'a, T>(
    result: Result<MutexGuard<'a, T>, PoisonError<MutexGuard<'a, T>>>,
) -> MutexGuard<'a, T> {
    result.unwrap_or_else(PoisonError::into_inner)
}

impl<K: Eq + Hash + Clone, V: Clone> TtlCache<K, V> {
    pub fn new(ttl: Duration) -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// Per-key jitter in `[0, ttl/10)`, derived deterministically from the key
    /// hash rather than a random number generator. Entries populated together
    /// (e.g. a bulk price scan across dozens of types) would otherwise all
    /// expire at exactly `insert_time + ttl` and stampede ESI/Fuzzwork with N
    /// simultaneous upstream requests the instant the batch goes stale —
    /// exactly the kind of burst the ESI error budget (`X-Esi-Error-Limit-*`)
    /// is meant to police. Spreading expiries by key keeps repeated `put`s of
    /// the *same* key stable (single-flight in `flight.rs` still collapses
    /// those) while decorrelating *different* keys' expiry instants.
    fn jitter(&self, key: &K) -> Duration
    where
        K: Hash,
    {
        let max_jitter = self.ttl / 10;
        let max_jitter_nanos = max_jitter.as_nanos();
        if max_jitter_nanos == 0 {
            return Duration::ZERO;
        }
        let mut hasher = DefaultHasher::new();
        key.hash(&mut hasher);
        let jitter_nanos = (hasher.finish() as u128) % max_jitter_nanos;
        Duration::from_nanos(jitter_nanos as u64)
    }

    /// Returns a clone of the cached value if present and not expired.
    pub fn get(&self, key: &K) -> Option<V> {
        let map = recover_lock(self.map.lock());
        map.get(key).and_then(|(expires_at, value)| {
            if Instant::now() < *expires_at {
                Some(value.clone())
            } else {
                None
            }
        })
    }

    pub fn put(&self, key: K, value: V) {
        let mut map = recover_lock(self.map.lock());
        let now = Instant::now();
        // Drop any entries that have aged out before inserting. Without this the
        // map only ever grows — `get` skips expired entries but never removes
        // them — so over a long session stale (region, type) prices would
        // accumulate unbounded. The sweep is O(n) but n is small (a handful of
        // regions × requested types) and puts only happen behind a network
        // fetch, so the cost is negligible.
        map.retain(|_, (expires_at, _)| *expires_at > now);
        let jitter = self.jitter(&key);
        map.insert(key, (now + self.ttl + jitter, value));
    }

    /// Number of live entries. Test-only; used to assert eviction behaviour.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        recover_lock(self.map.lock()).len()
    }

    /// The stored expiry instant for a key. Test-only; used to assert jitter
    /// decorrelates different keys' expiries.
    #[cfg(test)]
    pub fn expires_at(&self, key: &K) -> Option<Instant> {
        recover_lock(self.map.lock()).get(key).map(|(expires_at, _)| *expires_at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_fresh_value() {
        let cache: TtlCache<i64, String> = TtlCache::new(Duration::from_secs(60));
        cache.put(1, "hello".into());
        assert_eq!(cache.get(&1), Some("hello".into()));
        assert_eq!(cache.get(&2), None);
    }

    #[test]
    fn expired_value_is_not_returned() {
        // Zero TTL: any stored entry is immediately considered expired.
        let cache: TtlCache<i64, String> = TtlCache::new(Duration::ZERO);
        cache.put(1, "hello".into());
        assert_eq!(cache.get(&1), None);
    }

    #[test]
    fn put_evicts_expired_entries() {
        // Zero TTL: the first entry is already expired when the second is put,
        // so the sweep on the second `put` must physically remove it.
        let cache: TtlCache<i64, String> = TtlCache::new(Duration::ZERO);
        cache.put(1, "a".into());
        cache.put(2, "b".into());
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn put_keeps_fresh_entries() {
        // Long TTL: nothing is expired, so eviction must not drop live entries.
        let cache: TtlCache<i64, String> = TtlCache::new(Duration::from_secs(60));
        cache.put(1, "a".into());
        cache.put(2, "b".into());
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn put_jitters_expiry_per_key() {
        // Entries inserted back-to-back (effectively "the same instant" at
        // test granularity) must not share an expiry, or a batch of puts
        // would all go stale together and stampede upstream on the next read.
        let cache: TtlCache<i64, String> = TtlCache::new(Duration::from_secs(100));
        cache.put(1, "a".into());
        cache.put(2, "b".into());
        assert_ne!(cache.expires_at(&1), cache.expires_at(&2));
    }
}
