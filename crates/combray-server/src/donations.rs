//! Donation storage, kept in two places on purpose ([ADR 0006](../../../docs/decisions/0006-revocable-donation-keys.md)):
//!
//! - **Envelopes** (ciphertext) as files under `donations/{project}/{id}`, with a small index
//!   and the withdrawal tombstones in `donations.sqlite`. These can be backed up for as long as
//!   the institution likes: without the sealed keys they are unreadable.
//! - **Sealed donation keys** in `donation-keys.sqlite`, a separate file with its own, short
//!   backup retention. Withdrawing deletes the sealed key (with `secure_delete`), which makes
//!   every copy of the envelope unreadable, including copies researchers downloaded.
//!
//! On start, every sealed key with a tombstone is deleted again, so restoring an old backup of
//! the key database cannot bring a withdrawn donation back.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::accounts::b64;
use crate::util::{random_token, today, valid_random_id};

#[derive(Debug, PartialEq, Eq)]
pub enum DonationError {
    NotFound,
    /// Wrong withdrawal token.
    Forbidden,
    /// A donation with this id exists, or was withdrawn.
    Conflict,
    Internal(&'static str),
}

impl From<rusqlite::Error> for DonationError {
    fn from(_: rusqlite::Error) -> Self {
        DonationError::Internal("database")
    }
}

impl From<std::io::Error> for DonationError {
    fn from(_: std::io::Error) -> Self {
        DonationError::Internal("io")
    }
}

#[derive(Debug, Serialize)]
pub struct DonationInfo {
    pub id: String,
    pub day: String,
    pub bytes: i64,
}

#[derive(Debug, Serialize)]
pub struct Withdrawn {
    pub id: String,
    pub day: String,
}

#[derive(Debug, Serialize)]
pub struct SealedDonationKey {
    pub id: String,
    pub key: String,
    pub enc: String,
    pub ciphertext: String,
}

pub struct NewDonation<'a> {
    pub project: &'a str,
    pub id: &'a str,
    pub key_fingerprint: &'a str,
    pub enc: &'a [u8],
    pub ciphertext: &'a [u8],
    pub envelope: &'a [u8],
}

pub struct Donations {
    index: Mutex<Connection>,
    keys: Mutex<Connection>,
    dir: PathBuf,
}

fn open_db(path: &Path, schema: &str) -> std::io::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let db = Connection::open(path).map_err(std::io::Error::other)?;
    db.execute_batch(schema).map_err(std::io::Error::other)?;
    Ok(db)
}

impl Donations {
    /// Open the donation index and envelope directory under `data_dir`, and the key database at
    /// `keys_path`.
    pub fn open(data_dir: &Path, keys_path: &Path) -> std::io::Result<Donations> {
        let index = open_db(
            &data_dir.join("donations.sqlite"),
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS donations (
                 id              TEXT PRIMARY KEY,
                 project         TEXT NOT NULL,
                 day             TEXT NOT NULL,
                 bytes           INTEGER NOT NULL,
                 withdrawal_hash BLOB NOT NULL
             );
             CREATE INDEX IF NOT EXISTS donations_project ON donations (project);
             CREATE TABLE IF NOT EXISTS tombstones (
                 id      TEXT PRIMARY KEY,
                 project TEXT NOT NULL,
                 day     TEXT NOT NULL
             );",
        )?;
        let keys = open_db(
            keys_path,
            "PRAGMA journal_mode = WAL;
             PRAGMA secure_delete = ON;
             CREATE TABLE IF NOT EXISTS sealed_keys (
                 donation    TEXT PRIMARY KEY,
                 project     TEXT NOT NULL,
                 fingerprint TEXT NOT NULL,
                 enc         BLOB NOT NULL,
                 ciphertext  BLOB NOT NULL
             );",
        )?;
        let dir = data_dir.join("donations");
        std::fs::create_dir_all(&dir)?;
        let donations = Donations {
            index: Mutex::new(index),
            keys: Mutex::new(keys),
            dir,
        };
        donations
            .reapply_withdrawals()
            .map_err(|_| std::io::Error::other("could not re-apply withdrawals"))?;
        Ok(donations)
    }

    fn envelope_path(&self, project: &str, id: &str) -> PathBuf {
        self.dir.join(project).join(id)
    }

    /// Delete every sealed key that has a tombstone. Runs on start, after a restore.
    fn reapply_withdrawals(&self) -> Result<usize, DonationError> {
        let ids: Vec<String> = {
            let index = self
                .index
                .lock()
                .map_err(|_| DonationError::Internal("lock"))?;
            let mut stmt = index.prepare("SELECT id FROM tombstones")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?
        };
        let keys = self
            .keys
            .lock()
            .map_err(|_| DonationError::Internal("lock"))?;
        let mut deleted = 0;
        for id in ids {
            deleted += keys.execute("DELETE FROM sealed_keys WHERE donation = ?1", params![id])?;
        }
        if deleted > 0 {
            tracing::warn!(
                count = deleted,
                "deleted sealed keys of withdrawn donations (a key database backup was restored?)"
            );
        }
        Ok(deleted)
    }

    /// Store a donation. The caller checked the envelope's header against the project and its
    /// key. Returns the withdrawal token for the participant's receipt.
    pub fn store(&self, d: NewDonation) -> Result<String, DonationError> {
        if !valid_random_id(d.id) {
            return Err(DonationError::Internal("id"));
        }
        let token = random_token().map_err(|_| DonationError::Internal("random"))?;
        {
            let index = self
                .index
                .lock()
                .map_err(|_| DonationError::Internal("lock"))?;
            let taken = index
                .query_row(
                    "SELECT 1 FROM donations WHERE id = ?1 UNION SELECT 1 FROM tombstones WHERE id = ?1",
                    params![d.id],
                    |_| Ok(()),
                )
                .optional()?;
            if taken.is_some() {
                return Err(DonationError::Conflict);
            }
            // The envelope first, then the key, then the index entry that makes it visible.
            let path = self.envelope_path(d.project, d.id);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, d.envelope)?;
            let keys = self
                .keys
                .lock()
                .map_err(|_| DonationError::Internal("lock"))?;
            keys.execute(
                "INSERT INTO sealed_keys (donation, project, fingerprint, enc, ciphertext)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![d.id, d.project, d.key_fingerprint, d.enc, d.ciphertext],
            )?;
            index.execute(
                "INSERT INTO donations (id, project, day, bytes, withdrawal_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    d.id,
                    d.project,
                    today(),
                    d.envelope.len() as i64,
                    Sha256::digest(token).as_slice()
                ],
            )?;
        }
        Ok(b64(&token))
    }

    /// Withdraw a donation: delete its sealed key and envelope, keep a tombstone.
    fn withdraw(&self, project: &str, id: &str) -> Result<(), DonationError> {
        self.keys
            .lock()
            .map_err(|_| DonationError::Internal("lock"))?
            .execute("DELETE FROM sealed_keys WHERE donation = ?1", params![id])?;
        {
            let mut index = self
                .index
                .lock()
                .map_err(|_| DonationError::Internal("lock"))?;
            let tx = index.transaction()?;
            tx.execute("DELETE FROM donations WHERE id = ?1", params![id])?;
            tx.execute(
                "INSERT OR IGNORE INTO tombstones (id, project, day) VALUES (?1, ?2, ?3)",
                params![id, project, today()],
            )?;
            tx.commit()?;
        }
        match std::fs::remove_file(self.envelope_path(project, id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Withdraw with the participant's withdrawal token.
    pub fn withdraw_with_token(&self, id: &str, token: &[u8]) -> Result<(), DonationError> {
        if !valid_random_id(id) {
            return Err(DonationError::NotFound);
        }
        let row: Option<(String, Vec<u8>)> = self
            .index
            .lock()
            .map_err(|_| DonationError::Internal("lock"))?
            .query_row(
                "SELECT project, withdrawal_hash FROM donations WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((project, expected)) = row else {
            return Err(DonationError::NotFound);
        };
        if !bool::from(Sha256::digest(token).as_slice().ct_eq(&expected)) {
            return Err(DonationError::Forbidden);
        }
        self.withdraw(&project, id)
    }

    /// Withdraw on a participant's behalf, by a researcher of the project.
    pub fn withdraw_for_project(&self, project: &str, id: &str) -> Result<(), DonationError> {
        let exists = self
            .index
            .lock()
            .map_err(|_| DonationError::Internal("lock"))?
            .query_row(
                "SELECT 1 FROM donations WHERE id = ?1 AND project = ?2",
                params![id, project],
                |_| Ok(()),
            )
            .optional()?;
        if exists.is_none() {
            return Err(DonationError::NotFound);
        }
        self.withdraw(project, id)
    }

    pub fn list(
        &self,
        project: &str,
    ) -> Result<(Vec<DonationInfo>, Vec<Withdrawn>), DonationError> {
        let index = self
            .index
            .lock()
            .map_err(|_| DonationError::Internal("lock"))?;
        let mut stmt = index
            .prepare("SELECT id, day, bytes FROM donations WHERE project = ?1 ORDER BY day, id")?;
        let donations = stmt
            .query_map(params![project], |r| {
                Ok(DonationInfo {
                    id: r.get(0)?,
                    day: r.get(1)?,
                    bytes: r.get(2)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut stmt =
            index.prepare("SELECT id, day FROM tombstones WHERE project = ?1 ORDER BY day, id")?;
        let withdrawn = stmt
            .query_map(params![project], |r| {
                Ok(Withdrawn {
                    id: r.get(0)?,
                    day: r.get(1)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok((donations, withdrawn))
    }

    pub fn envelope(&self, project: &str, id: &str) -> Result<Vec<u8>, DonationError> {
        if !valid_random_id(id) {
            return Err(DonationError::NotFound);
        }
        let exists = self
            .index
            .lock()
            .map_err(|_| DonationError::Internal("lock"))?
            .query_row(
                "SELECT 1 FROM donations WHERE id = ?1 AND project = ?2",
                params![id, project],
                |_| Ok(()),
            )
            .optional()?;
        if exists.is_none() {
            return Err(DonationError::NotFound);
        }
        Ok(std::fs::read(self.envelope_path(project, id))?)
    }

    /// The sealed keys of the given donations of a project. Unknown or withdrawn ids are left out.
    pub fn sealed_keys(
        &self,
        project: &str,
        ids: &[String],
    ) -> Result<Vec<SealedDonationKey>, DonationError> {
        let keys = self
            .keys
            .lock()
            .map_err(|_| DonationError::Internal("lock"))?;
        let mut stmt = keys.prepare(
            "SELECT fingerprint, enc, ciphertext FROM sealed_keys WHERE donation = ?1 AND project = ?2",
        )?;
        let mut out = Vec::new();
        for id in ids.iter().filter(|id| valid_random_id(id)) {
            let row: Option<(String, Vec<u8>, Vec<u8>)> = stmt
                .query_row(params![id, project], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()?;
            if let Some((key, enc, ct)) = row {
                out.push(SealedDonationKey {
                    id: id.clone(),
                    key,
                    enc: b64(&enc),
                    ciphertext: b64(&ct),
                });
            }
        }
        Ok(out)
    }
}

/// The envelope header fields the server checks before accepting a donation. The header is
/// authenticated by the sealed key, so a client that lies here only produces a donation that
/// does not open.
#[derive(Debug, serde::Deserialize)]
pub struct EnvelopeHeader {
    pub v: u32,
    pub project: String,
    pub donation: String,
    pub key: String,
}

const MAGIC: &[u8] = b"CMBRDON1";

/// Read the header of an envelope (see packages/seal/src/envelope.ts).
pub fn read_header(envelope: &[u8]) -> Option<EnvelopeHeader> {
    if envelope.len() < 12 || &envelope[..8] != MAGIC {
        return None;
    }
    let length = u32::from_be_bytes(envelope[8..12].try_into().ok()?) as usize;
    if length > 16 * 1024 || 12 + length > envelope.len() {
        return None;
    }
    serde_json::from_slice(&envelope[12..12 + length]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(project: &str, id: &str) -> Vec<u8> {
        let header =
            format!(r#"{{"v":1,"project":"{project}","donation":"{id}","key":"fp","chunks":1}}"#);
        let mut out = MAGIC.to_vec();
        out.extend_from_slice(&(header.len() as u32).to_be_bytes());
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(b"ciphertext");
        out
    }

    const ID: &str = "AAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn reads_headers() {
        let h = read_header(&envelope("willow", ID)).unwrap();
        assert_eq!(
            (h.v, h.project.as_str(), h.donation.as_str()),
            (1, "willow", ID)
        );
        assert!(read_header(b"not an envelope").is_none());
    }

    #[test]
    fn withdrawal_deletes_keys_and_survives_a_restore() {
        let dir = tempfile::tempdir().unwrap();
        let keys_path = dir.path().join("keys/donation-keys.sqlite");
        let d = Donations::open(dir.path(), &keys_path).unwrap();
        let env = envelope("willow", ID);
        let token = d
            .store(NewDonation {
                project: "willow",
                id: ID,
                key_fingerprint: "fp",
                enc: b"enc",
                ciphertext: b"ct",
                envelope: &env,
            })
            .unwrap();
        assert_eq!(d.envelope("willow", ID).unwrap(), env);
        assert_eq!(d.sealed_keys("willow", &[ID.to_owned()]).unwrap().len(), 1);
        assert!(d.sealed_keys("oak", &[ID.to_owned()]).unwrap().is_empty());

        // Back up the key database, then withdraw.
        drop(d);
        std::fs::copy(&keys_path, dir.path().join("backup.sqlite")).unwrap();
        let d = Donations::open(dir.path(), &keys_path).unwrap();
        assert_eq!(
            d.withdraw_with_token(ID, b"wrong"),
            Err(DonationError::Forbidden)
        );
        let token =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, &token)
                .unwrap();
        d.withdraw_with_token(ID, &token).unwrap();
        assert!(
            d.sealed_keys("willow", &[ID.to_owned()])
                .unwrap()
                .is_empty()
        );
        assert_eq!(d.envelope("willow", ID), Err(DonationError::NotFound));
        let (live, withdrawn) = d.list("willow").unwrap();
        assert!(live.is_empty());
        assert_eq!(withdrawn.len(), 1);

        // Restoring the old key database does not bring the key back.
        drop(d);
        std::fs::copy(dir.path().join("backup.sqlite"), &keys_path).unwrap();
        let _ = std::fs::remove_file(keys_path.with_extension("sqlite-wal"));
        let d = Donations::open(dir.path(), &keys_path).unwrap();
        assert!(
            d.sealed_keys("willow", &[ID.to_owned()])
                .unwrap()
                .is_empty()
        );

        // A withdrawn id cannot be used again.
        assert_eq!(
            d.store(NewDonation {
                project: "willow",
                id: ID,
                key_fingerprint: "fp",
                enc: b"enc",
                ciphertext: b"ct",
                envelope: &env,
            }),
            Err(DonationError::Conflict)
        );
    }
}
