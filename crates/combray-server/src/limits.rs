//! Fixed-window rate limits, in memory. Keys (client IPs, email hashes) are never stored on disk
//! or logged.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimit<K> {
    max: u32,
    window: Duration,
    windows: Mutex<HashMap<K, (Instant, u32)>>,
}

impl<K: Eq + Hash> RateLimit<K> {
    pub fn new(max: u32, window: Duration) -> RateLimit<K> {
        RateLimit {
            max,
            window,
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Count one request for `key`. Returns the seconds to wait when the window is full.
    pub fn hit(&self, key: K) -> Result<(), u64> {
        let now = Instant::now();
        let Ok(mut windows) = self.windows.lock() else {
            return Err(1);
        };
        if windows.len() > 100_000 {
            windows.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        let entry = windows.entry(key).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        if entry.1 >= self.max {
            return Err(self
                .window
                .saturating_sub(now.duration_since(entry.0))
                .as_secs()
                .max(1));
        }
        entry.1 += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_once_the_window_is_full() {
        let limit = RateLimit::new(2, Duration::from_secs(60));
        assert!(limit.hit("a").is_ok());
        assert!(limit.hit("a").is_ok());
        assert!(limit.hit("a").is_err());
        assert!(limit.hit("b").is_ok());
    }
}
