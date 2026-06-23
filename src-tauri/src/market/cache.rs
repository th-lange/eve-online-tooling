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
        self.map
            .lock()
            .unwrap()
            .insert(key, (Instant::now(), value));
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
}
