//! The store key service: holds the key encryption key (KEK) for each participant's local store
//! and releases it only in exchange for the store's password. See docs/security.md#store-keys.
//!
//! - The server never sees the store's data or its data key (DEK). The device keeps the DEK,
//!   wrapped under the KEK, next to the encrypted data. Neither side alone can read the data.
//! - KEK = HKDF-SHA-256(ikm = master key, salt = per-store random salt, info = label || store id).
//!   The database holds only the salt, so a copy of the database without the master key yields
//!   no keys, and deleting the row crypto-shreds the store.
//! - Passwords are hashed with Argon2id. Failed attempts are counted per store *before* the hash
//!   is checked, so parallel guesses are counted too, and lead to an increasing lockout.
//! - Per client IP, attempts and new stores are rate limited in memory. IPs are never stored or
//!   logged.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

const KEK_INFO: &[u8] = b"combray/store-kek/v1/";
pub const MIN_PASSWORD_CHARS: usize = 8;
pub const MAX_PASSWORD_BYTES: usize = 1024;
/// Failed attempts allowed before the lockout starts.
const FREE_ATTEMPTS: i64 = 5;
const LOCKOUT_BASE_SECS: i64 = 30;
const LOCKOUT_MAX_SECS: i64 = 3600;

/// Argon2id cost. The default is the OWASP recommendation (19 MiB, 2 passes, 1 lane).
#[derive(Clone, Copy, Debug)]
pub struct Argon2Cost {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for Argon2Cost {
    fn default() -> Self {
        Argon2Cost {
            m_kib: 19 * 1024,
            t: 2,
            p: 1,
        }
    }
}

/// How many requests a client IP may make per window.
#[derive(Clone, Copy, Debug)]
pub struct RateLimits {
    pub attempts: u32,
    pub creates: u32,
    pub window: Duration,
}

impl Default for RateLimits {
    fn default() -> Self {
        // Generous, because a whole lab can share one IP. The per-store lockout is the real
        // defence against guessing; this one limits spraying many stores and filling the disk.
        RateLimits {
            attempts: 120,
            creates: 60,
            window: Duration::from_secs(600),
        }
    }
}

#[derive(Debug)]
pub enum KeyError {
    /// The password is too short or too long.
    InvalidPassword,
    /// No such store (never created, or deleted).
    NotFound,
    WrongPassword {
        retry_after: Option<u64>,
    },
    /// Locked out, per store or per IP.
    TooManyAttempts {
        retry_after: u64,
    },
    Internal(&'static str),
}

impl From<rusqlite::Error> for KeyError {
    fn from(_: rusqlite::Error) -> Self {
        KeyError::Internal("database")
    }
}

pub struct NewStore {
    pub store_id: String,
    pub kek: String,
    /// Lets the device delete the store's key without the password, e.g. when the participant
    /// forgot it and chooses to start over. Harmless to keep on the device: whoever can use it
    /// could delete the local data anyway. The server keeps only its SHA-256.
    pub delete_token: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Bucket {
    Attempt,
    Create,
}

pub struct KeyService {
    db: Mutex<Connection>,
    master: [u8; 32],
    cost: Argon2Cost,
    limits: RateLimits,
    /// Argon2 is memory hard: bound how many hashes run at once.
    hashing: Semaphore,
    windows: Mutex<HashMap<(Bucket, IpAddr), (Instant, u32)>>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn random<const N: usize>() -> Result<[u8; N], KeyError> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| KeyError::Internal("random"))?;
    Ok(bytes)
}

fn valid_store_id(id: &str) -> bool {
    id.len() == 22
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn check_password(password: &str) -> Result<(), KeyError> {
    if password.chars().count() < MIN_PASSWORD_CHARS || password.len() > MAX_PASSWORD_BYTES {
        return Err(KeyError::InvalidPassword);
    }
    Ok(())
}

/// Read the master key, or create one if the file does not exist yet.
pub fn load_master_key(path: &Path) -> std::io::Result<[u8; 32]> {
    match std::fs::read(path) {
        Ok(bytes) => bytes.try_into().map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "the master key file must hold exactly 32 bytes",
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut key = [0u8; 32];
            getrandom::fill(&mut key).map_err(std::io::Error::other)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            std::io::Write::write_all(&mut options.open(path)?, &key)?;
            tracing::warn!("created a new master key file; back it up separately from the data");
            Ok(key)
        }
        Err(e) => Err(e),
    }
}

impl KeyService {
    pub fn open(
        db_path: &Path,
        master: [u8; 32],
        cost: Argon2Cost,
        limits: RateLimits,
    ) -> std::io::Result<KeyService> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(db_path).map_err(std::io::Error::other)?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA secure_delete = ON;
             CREATE TABLE IF NOT EXISTS stores (
                 id           TEXT PRIMARY KEY,
                 kek_salt     BLOB NOT NULL,
                 pw_salt      BLOB NOT NULL,
                 pw_hash      BLOB NOT NULL,
                 delete_hash  BLOB NOT NULL,
                 m_kib        INTEGER NOT NULL,
                 t_cost       INTEGER NOT NULL,
                 p_cost       INTEGER NOT NULL,
                 failures     INTEGER NOT NULL DEFAULT 0,
                 locked_until INTEGER NOT NULL DEFAULT 0
             );",
        )
        .map_err(std::io::Error::other)?;
        let parallel = std::thread::available_parallelism().map_or(2, |n| n.get());
        Ok(KeyService {
            db: Mutex::new(db),
            master,
            cost,
            limits,
            hashing: Semaphore::new(parallel),
            windows: Mutex::new(HashMap::new()),
        })
    }

    fn kek(&self, store_id: &str, salt: &[u8]) -> Result<String, KeyError> {
        let mut info = KEK_INFO.to_vec();
        info.extend_from_slice(store_id.as_bytes());
        let mut kek = [0u8; 32];
        Hkdf::<Sha256>::new(Some(salt), &self.master)
            .expand(&info, &mut kek)
            .map_err(|_| KeyError::Internal("hkdf"))?;
        Ok(URL_SAFE_NO_PAD.encode(kek))
    }

    async fn hash(
        &self,
        password: &str,
        salt: [u8; 16],
        cost: Argon2Cost,
    ) -> Result<[u8; 32], KeyError> {
        let _permit = self
            .hashing
            .acquire()
            .await
            .map_err(|_| KeyError::Internal("semaphore"))?;
        let password = password.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || {
            let params = Params::new(cost.m_kib, cost.t, cost.p, Some(32))
                .map_err(|_| KeyError::Internal("argon2 params"))?;
            let mut out = [0u8; 32];
            Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
                .hash_password_into(&password, &salt, &mut out)
                .map_err(|_| KeyError::Internal("argon2"))?;
            Ok(out)
        })
        .await
        .map_err(|_| KeyError::Internal("join"))?
    }

    /// Count a request from `ip` against its window; refuse it once the window is full.
    fn rate_limit(&self, bucket: Bucket, ip: IpAddr) -> Result<(), KeyError> {
        let max = match bucket {
            Bucket::Attempt => self.limits.attempts,
            Bucket::Create => self.limits.creates,
        };
        let now = Instant::now();
        let window = self.limits.window;
        let mut windows = self
            .windows
            .lock()
            .map_err(|_| KeyError::Internal("lock"))?;
        if windows.len() > 100_000 {
            windows.retain(|_, (start, _)| now.duration_since(*start) < window);
        }
        let entry = windows.entry((bucket, ip)).or_insert((now, 0));
        if now.duration_since(entry.0) >= window {
            *entry = (now, 0);
        }
        if entry.1 >= max {
            let retry = window
                .saturating_sub(now.duration_since(entry.0))
                .as_secs()
                .max(1);
            return Err(KeyError::TooManyAttempts { retry_after: retry });
        }
        entry.1 += 1;
        Ok(())
    }

    /// Create a store protected by `password`. Returns its id and KEK.
    pub async fn create(&self, ip: IpAddr, password: &str) -> Result<NewStore, KeyError> {
        check_password(password)?;
        self.rate_limit(Bucket::Create, ip)?;
        let store_id = URL_SAFE_NO_PAD.encode(random::<16>()?);
        let kek_salt = random::<32>()?;
        let pw_salt = random::<16>()?;
        let cost = self.cost;
        let hash = self.hash(password, pw_salt, cost).await?;
        let delete_token = random::<32>()?;
        let delete_hash = Sha256::digest(delete_token);
        self.db
            .lock()
            .map_err(|_| KeyError::Internal("lock"))?
            .execute(
                "INSERT INTO stores (id, kek_salt, pw_salt, pw_hash, m_kib, t_cost, p_cost, delete_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    store_id,
                    kek_salt,
                    pw_salt,
                    hash,
                    cost.m_kib,
                    cost.t,
                    cost.p,
                    delete_hash.as_slice()
                ],
            )?;
        let kek = self.kek(&store_id, &kek_salt)?;
        Ok(NewStore {
            store_id,
            kek,
            delete_token: URL_SAFE_NO_PAD.encode(delete_token),
        })
    }

    /// Check the password; on success, reset the failure count and return the store's KEK salt.
    async fn verify(
        &self,
        ip: IpAddr,
        store_id: &str,
        password: &str,
    ) -> Result<Vec<u8>, KeyError> {
        if !valid_store_id(store_id) {
            return Err(KeyError::NotFound);
        }
        if password.len() > MAX_PASSWORD_BYTES {
            return Err(KeyError::InvalidPassword);
        }
        self.rate_limit(Bucket::Attempt, ip)?;
        let now = now_secs();
        // Count this attempt as failed up front, in one transaction with the lockout check.
        let (kek_salt, pw_salt, pw_hash, cost, failures) = {
            let mut db = self.db.lock().map_err(|_| KeyError::Internal("lock"))?;
            let tx = db.transaction()?;
            let row = tx
                .query_row(
                    "SELECT kek_salt, pw_salt, pw_hash, m_kib, t_cost, p_cost, failures, locked_until
                     FROM stores WHERE id = ?1",
                    params![store_id],
                    |r| {
                        Ok((
                            r.get::<_, Vec<u8>>(0)?,
                            r.get::<_, Vec<u8>>(1)?,
                            r.get::<_, Vec<u8>>(2)?,
                            Argon2Cost {
                                m_kib: r.get(3)?,
                                t: r.get(4)?,
                                p: r.get(5)?,
                            },
                            r.get::<_, i64>(6)?,
                            r.get::<_, i64>(7)?,
                        ))
                    },
                )
                .optional()?;
            let Some((kek_salt, pw_salt, pw_hash, cost, failures, locked_until)) = row else {
                return Err(KeyError::NotFound);
            };
            if locked_until > now {
                return Err(KeyError::TooManyAttempts {
                    retry_after: (locked_until - now) as u64,
                });
            }
            let failures = failures + 1;
            tx.execute(
                "UPDATE stores SET failures = ?1, locked_until = ?2 WHERE id = ?3",
                params![failures, now + lockout_secs(failures), store_id],
            )?;
            tx.commit()?;
            (kek_salt, pw_salt, pw_hash, cost, failures)
        };
        let salt: [u8; 16] = pw_salt.try_into().map_err(|_| KeyError::Internal("salt"))?;
        let hash = self.hash(password, salt, cost).await?;
        if !bool::from(hash.ct_eq(pw_hash.as_slice())) {
            let lockout = lockout_secs(failures);
            return Err(KeyError::WrongPassword {
                retry_after: (lockout > 0).then_some(lockout as u64),
            });
        }
        self.db
            .lock()
            .map_err(|_| KeyError::Internal("lock"))?
            .execute(
                "UPDATE stores SET failures = 0, locked_until = 0 WHERE id = ?1",
                params![store_id],
            )?;
        Ok(kek_salt)
    }

    /// Return the store's KEK, if the password is right.
    pub async fn unlock(
        &self,
        ip: IpAddr,
        store_id: &str,
        password: &str,
    ) -> Result<String, KeyError> {
        let kek_salt = self.verify(ip, store_id, password).await?;
        self.kek(store_id, &kek_salt)
    }

    /// Forget the store's KEK salt, which makes the data on the device unreadable for good.
    pub async fn delete(
        &self,
        ip: IpAddr,
        store_id: &str,
        delete_token: &str,
    ) -> Result<(), KeyError> {
        if !valid_store_id(store_id) {
            return Err(KeyError::NotFound);
        }
        self.rate_limit(Bucket::Attempt, ip)?;
        let token = URL_SAFE_NO_PAD
            .decode(delete_token)
            .map_err(|_| KeyError::WrongPassword { retry_after: None })?;
        let db = self.db.lock().map_err(|_| KeyError::Internal("lock"))?;
        let expected: Option<Vec<u8>> = db
            .query_row(
                "SELECT delete_hash FROM stores WHERE id = ?1",
                params![store_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(expected) = expected else {
            return Err(KeyError::NotFound);
        };
        if !bool::from(Sha256::digest(&token).as_slice().ct_eq(expected.as_slice())) {
            return Err(KeyError::WrongPassword { retry_after: None });
        }
        db.execute("DELETE FROM stores WHERE id = ?1", params![store_id])?;
        Ok(())
    }
}

/// Seconds to wait after the given number of failed attempts: none for the first few, then
/// doubling from 30 seconds up to an hour.
fn lockout_secs(failures: i64) -> i64 {
    if failures < FREE_ATTEMPTS {
        return 0;
    }
    let doublings = (failures - FREE_ATTEMPTS).min(20) as u32;
    (LOCKOUT_BASE_SECS << doublings).min(LOCKOUT_MAX_SECS)
}

pub type SharedKeyService = Arc<KeyService>;

#[cfg(test)]
mod tests {
    use super::lockout_secs;

    #[test]
    fn lockout_grows_and_is_capped() {
        assert_eq!(lockout_secs(1), 0);
        assert_eq!(lockout_secs(4), 0);
        assert_eq!(lockout_secs(5), 30);
        assert_eq!(lockout_secs(6), 60);
        assert_eq!(lockout_secs(12), 3600);
        assert_eq!(lockout_secs(1000), 3600);
    }
}
