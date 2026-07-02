//! A tiny thread-safe TTL cache, used to honor ESI cache timers (orders ~5 min,
//! history ~daily, global prices ~hourly) so repeated profit calculations don't
//! refetch.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct TtlCache<K, V> {
    map: Mutex<HashMap<K, (Instant, V)>>,
    ttl: Duration,
}

impl<K: Eq + Hash + Clone, V: Clone> TtlCache<K, V> {
    pub fn new(ttl: Duration) -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// Returns a clone of the cached value if present and not expired.
    pub fn get(&self, key: &K) -> Option<V> {
        let map = self.map.lock().unwrap();
        map.get(key).and_then(|(stored_at, value)| {
            if stored_at.elapsed() < self.ttl {
                Some(value.clone())
            } else {
                None
            }
        })
    }

    pub fn put(&self, key: K, value: V) {
        let mut map = self.map.lock().unwrap();
        // Drop any entries that have aged out before inserting. Without this the
        // map only ever grows — `get` skips expired entries but never removes
        // them — so over a long session stale (region, type) prices would
        // accumulate unbounded. The sweep is O(n) but n is small (a handful of
        // regions × requested types) and puts only happen behind a network
        // fetch, so the cost is negligible.
        let ttl = self.ttl;
        map.retain(|_, (stored_at, _)| stored_at.elapsed() < ttl);
        map.insert(key, (Instant::now(), value));
    }

    /// Number of live entries. Test-only; used to assert eviction behaviour.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
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
}
