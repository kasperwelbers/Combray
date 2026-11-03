//! Researcher accounts, sign-in, project membership and project keys. See
//! docs/researcher-keys.md.
//!
//! The server never holds a key that opens anything. It stores:
//!
//! - each researcher's **personal public key**, and the SHA-256 of their recovery sign-in
//!   secret (a value derived from the recovery code, which itself never reaches the server);
//! - per passkey, the researcher's master secret **wrapped under the passkey's PRF output**,
//!   which only the authenticator can produce;
//! - per project, the **project public key**, and the project private key **sealed to each
//!   member's personal public key**.
//!
//! Secrets that grant access (session ids, handoff codes, the browser's pending email sign-in)
//! are random 256-bit values; the database keeps only their SHA-256. Emailed sign-in codes are
//! short, so they only work together with the pending sign-in of the browser that asked for them,
//! and only a few times. Nothing here is logged.

use std::path::Path;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use webauthn_rs::prelude::{Passkey, Uuid};

use crate::util::{now_secs, random_token};

/// How long an emailed sign-in code works.
pub const LOGIN_CODE_TTL_SECS: i64 = 10 * 60;
/// Wrong guesses before a sign-in code stops working.
pub const LOGIN_CODE_TRIES: i64 = 5;
/// After the email code, the second step (passkey or recovery code) must follow within this time.
pub const EMAIL_SESSION_TTL_SECS: i64 = 15 * 60;
/// A signed-in session on the key page. Short, because it can fetch sealed keys.
pub const KEYS_SESSION_TTL_SECS: i64 = 2 * 3600;
/// A signed-in session in the studio, which cannot fetch any key material. Long, so researchers
/// do not need an email code every time; opening donations needs the passkey on the key page.
pub const STUDIO_SESSION_TTL_SECS: i64 = 30 * 24 * 3600;
/// A handoff code from the key page to the studio is used within seconds.
pub const HANDOFF_TTL_SECS: i64 = 120;
/// Personal and project public keys are X-Wing keys.
pub const PUBLIC_KEY_BYTES: usize = 1216;
const MAX_SEALED_BYTES: usize = 4096;
const MAX_PASSKEYS: i64 = 10;

type Blob = Vec<u8>;

#[derive(Debug, PartialEq, Eq)]
pub enum AccountError {
    NotFound,
    /// Not allowed for this researcher, or in this state.
    Forbidden,
    /// The request conflicts with what is there (e.g. a key exists already).
    Conflict,
    Invalid,
    Internal(&'static str),
}

impl From<rusqlite::Error> for AccountError {
    fn from(_: rusqlite::Error) -> Self {
        AccountError::Internal("database")
    }
}

/// Which site a session belongs to: the key page, or the main site (where the studio is).
/// Sessions never cross: a studio session cannot fetch key material, and a cookie from one host
/// is never sent to the other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Site {
    Keys,
    Main,
}

impl Site {
    fn as_str(self) -> &'static str {
        match self {
            Site::Keys => "keys",
            Site::Main => "main",
        }
    }
}

/// How far sign-in has got.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    /// The email code was used; the passkey or recovery code is still needed.
    Email,
    /// Fully signed in.
    Full,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub researcher_id: String,
    pub site: Site,
    pub level: Level,
    /// The id of the session record (the SHA-256 of the cookie value).
    pub key: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PasskeyInfo {
    pub id: String,
    pub name: String,
    pub created: i64,
    pub last_used: Option<i64>,
    /// Whether the personal key is stored wrapped under this passkey (it supports PRF).
    pub unlocks_key: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Me {
    pub id: String,
    pub email: String,
    /// Base64url, if the personal key is set up.
    pub public_key: Option<String>,
    pub passkeys: Vec<PasskeyInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MemberInfo {
    pub researcher_id: String,
    pub email: String,
    pub public_key: Option<String>,
    /// Whether the member holds a sealed copy of the project key.
    pub has_access: bool,
    pub added: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct SealedKey {
    pub enc: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectKeyInfo {
    pub public_key: String,
    pub fingerprint: String,
    pub created: i64,
}

pub struct Accounts {
    db: Mutex<Connection>,
}

fn hash(token: &[u8]) -> Vec<u8> {
    Sha256::digest(token).to_vec()
}

/// Sign-in codes have 8 digits: with the tries and rate limits, guessing one is out of reach.
fn new_login_code() -> Result<String, AccountError> {
    let bytes = crate::util::random::<8>().map_err(|_| AccountError::Internal("random"))?;
    // The bias of reducing a 64-bit number modulo 10^8 is below 10^-10.
    Ok(format!("{:08}", u64::from_le_bytes(bytes) % 100_000_000))
}

/// A code is stored hashed with its browser's secret, so the database alone does not give it away
/// (8 digits would be quick to find from a plain hash), and with its site, so a code asked for on
/// the key page cannot sign in to the studio or the other way round.
fn code_hash(site: Site, request: &[u8], code: &str) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(b"combray/login-code/v1/");
    hasher.update(site.as_str().as_bytes());
    hasher.update(b"/");
    hasher.update(request);
    hasher.update(code.as_bytes());
    hasher.finalize().to_vec()
}

/// Forget a researcher's personal key, passkeys, sessions and copies of project keys.
fn clear_key(db: &Connection, id: &str) -> Result<(), AccountError> {
    db.execute(
        "UPDATE researchers SET public_key = NULL, recovery_verifier = NULL WHERE id = ?1",
        params![id],
    )?;
    db.execute("DELETE FROM passkeys WHERE researcher_id = ?1", params![id])?;
    db.execute("DELETE FROM sessions WHERE researcher_id = ?1", params![id])?;
    db.execute(
        "UPDATE members SET sealed_enc = NULL, sealed_ct = NULL WHERE researcher_id = ?1",
        params![id],
    )?;
    Ok(())
}

fn sole_access(db: &Connection, id: &str) -> Result<Vec<String>, AccountError> {
    let mut stmt = db.prepare(
        "SELECT m.project FROM members m
         WHERE m.researcher_id = ?1 AND m.sealed_ct IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM members o WHERE o.project = m.project
                           AND o.researcher_id != ?1 AND o.sealed_ct IS NOT NULL)
         ORDER BY m.project",
    )?;
    let rows = stmt
        .query_map(params![id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Why a researcher could not reset their own key.
#[derive(Debug, PartialEq, Eq)]
pub enum ResetError {
    /// They are the only member with access to these projects.
    SoleAccess(Vec<String>),
    Account(AccountError),
}

impl From<AccountError> for ResetError {
    fn from(e: AccountError) -> Self {
        ResetError::Account(e)
    }
}

impl From<rusqlite::Error> for ResetError {
    fn from(e: rusqlite::Error) -> Self {
        ResetError::Account(e.into())
    }
}

fn decode(token: &str) -> Result<Vec<u8>, AccountError> {
    URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|_| AccountError::Invalid)
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Emails are compared in lower case, trimmed. A light check only: the email code is the proof.
pub fn normalize_email(email: &str) -> Option<String> {
    let email = email.trim().to_lowercase();
    let (local, domain) = email.split_once('@')?;
    let ok = (3..=254).contains(&email.len())
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && email
            .bytes()
            .all(|b| b.is_ascii_graphic() && b != b'<' && b != b'>' && b != b'"');
    ok.then_some(email)
}

impl Accounts {
    pub fn open(path: &Path) -> std::io::Result<Accounts> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(path).map_err(std::io::Error::other)?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA secure_delete = ON;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS researchers (
                 id                TEXT PRIMARY KEY,
                 email             TEXT NOT NULL UNIQUE,
                 created           INTEGER NOT NULL,
                 public_key        BLOB,
                 recovery_verifier BLOB
             );
             CREATE TABLE IF NOT EXISTS passkeys (
                 id             TEXT PRIMARY KEY,
                 researcher_id  TEXT NOT NULL REFERENCES researchers(id) ON DELETE CASCADE,
                 passkey        TEXT NOT NULL,
                 name           TEXT NOT NULL,
                 wrapped_master BLOB,
                 created        INTEGER NOT NULL,
                 last_used      INTEGER
             );
             DROP TABLE IF EXISTS login_tokens;
             CREATE TABLE IF NOT EXISTS login_codes (
                 request_hash  BLOB PRIMARY KEY,
                 researcher_id TEXT REFERENCES researchers(id) ON DELETE CASCADE,
                 code_hash     BLOB NOT NULL,
                 tries         INTEGER NOT NULL DEFAULT 0,
                 expires       INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sessions (
                 token_hash    BLOB PRIMARY KEY,
                 researcher_id TEXT NOT NULL REFERENCES researchers(id) ON DELETE CASCADE,
                 site          TEXT NOT NULL,
                 level         TEXT NOT NULL,
                 expires       INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS handoffs (
                 code_hash     BLOB PRIMARY KEY,
                 researcher_id TEXT NOT NULL REFERENCES researchers(id) ON DELETE CASCADE,
                 expires       INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS project_keys (
                 project     TEXT PRIMARY KEY,
                 public_key  BLOB NOT NULL,
                 fingerprint TEXT NOT NULL,
                 created     INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS members (
                 project       TEXT NOT NULL,
                 researcher_id TEXT NOT NULL REFERENCES researchers(id) ON DELETE CASCADE,
                 sealed_enc    BLOB,
                 sealed_ct     BLOB,
                 added         INTEGER NOT NULL,
                 PRIMARY KEY (project, researcher_id)
             );",
        )
        .map_err(std::io::Error::other)?;
        Ok(Accounts { db: Mutex::new(db) })
    }

    fn db(&self) -> Result<std::sync::MutexGuard<'_, Connection>, AccountError> {
        self.db.lock().map_err(|_| AccountError::Internal("lock"))
    }

    // Researchers.

    /// Create a researcher account, or return the existing one for this email.
    pub fn add_researcher(&self, email: &str) -> Result<String, AccountError> {
        let email = normalize_email(email).ok_or(AccountError::Invalid)?;
        let db = self.db()?;
        if let Some(id) = db
            .query_row(
                "SELECT id FROM researchers WHERE email = ?1",
                params![email],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(id);
        }
        let id = Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO researchers (id, email, created) VALUES (?1, ?2, ?3)",
            params![id, email, now_secs()],
        )?;
        Ok(id)
    }

    pub fn remove_researcher(&self, email: &str) -> Result<(), AccountError> {
        let email = normalize_email(email).ok_or(AccountError::Invalid)?;
        let n = self
            .db()?
            .execute("DELETE FROM researchers WHERE email = ?1", params![email])?;
        if n == 0 {
            return Err(AccountError::NotFound);
        }
        Ok(())
    }

    pub fn list_researchers(&self) -> Result<Vec<(String, bool, i64)>, AccountError> {
        let db = self.db()?;
        let mut stmt = db.prepare(
            "SELECT r.email, r.public_key IS NOT NULL,
                    (SELECT COUNT(*) FROM passkeys p WHERE p.researcher_id = r.id)
             FROM researchers r ORDER BY r.email",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Forget a researcher's personal key and passkeys, and their sealed project keys. For when
    /// both the passkeys and the recovery code are lost; colleagues grant access again after.
    pub fn reset_researcher_key(&self, email: &str) -> Result<(), AccountError> {
        let email = normalize_email(email).ok_or(AccountError::Invalid)?;
        let mut db = self.db()?;
        let tx = db.transaction()?;
        let id: String = tx
            .query_row(
                "SELECT id FROM researchers WHERE email = ?1",
                params![email],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(AccountError::NotFound)?;
        clear_key(&tx, &id)?;
        tx.commit()?;
        Ok(())
    }

    /// The projects where this researcher is the only member with access to the project key.
    /// Resetting their key would leave nobody able to open those projects' donations.
    pub fn sole_access_projects(&self, researcher_id: &str) -> Result<Vec<String>, AccountError> {
        let db = self.db()?;
        sole_access(&db, researcher_id)
    }

    /// A researcher resets their own key after losing both passkey and recovery code: as the
    /// operator's `reset-key`, but refused (with the projects) while they are the only member with
    /// access to a project. Ends all their sessions.
    pub fn reset_own_key(&self, researcher_id: &str) -> Result<(), ResetError> {
        let mut db = self.db()?;
        let tx = db.transaction()?;
        let sole = sole_access(&tx, researcher_id)?;
        if !sole.is_empty() {
            return Err(ResetError::SoleAccess(sole));
        }
        clear_key(&tx, researcher_id)?;
        tx.commit()?;
        Ok(())
    }

    pub fn email_of(&self, researcher_id: &str) -> Result<String, AccountError> {
        self.db()?
            .query_row(
                "SELECT email FROM researchers WHERE id = ?1",
                params![researcher_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(AccountError::NotFound)
    }

    pub fn me(&self, researcher_id: &str) -> Result<Me, AccountError> {
        let db = self.db()?;
        let (email, public_key): (String, Option<Vec<u8>>) = db
            .query_row(
                "SELECT email, public_key FROM researchers WHERE id = ?1",
                params![researcher_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(AccountError::NotFound)?;
        let mut stmt = db.prepare(
            "SELECT id, name, created, last_used, wrapped_master IS NOT NULL
             FROM passkeys WHERE researcher_id = ?1 ORDER BY created",
        )?;
        let passkeys = stmt
            .query_map(params![researcher_id], |r| {
                Ok(PasskeyInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    created: r.get(2)?,
                    last_used: r.get(3)?,
                    unlocks_key: r.get(4)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(Me {
            id: researcher_id.to_owned(),
            email,
            public_key: public_key.map(|k| b64(&k)),
            passkeys,
        })
    }

    /// Set the personal public key, once. Changing it would let whoever changed it receive
    /// project keys, so it can only be cleared by the operator (`reset_researcher_key`).
    pub fn set_personal_key(
        &self,
        researcher_id: &str,
        public_key: &[u8],
        recovery_verifier: &[u8],
    ) -> Result<(), AccountError> {
        if public_key.len() != PUBLIC_KEY_BYTES || recovery_verifier.len() != 32 {
            return Err(AccountError::Invalid);
        }
        let n = self.db()?.execute(
            "UPDATE researchers SET public_key = ?1, recovery_verifier = ?2
             WHERE id = ?3 AND public_key IS NULL",
            params![public_key, recovery_verifier, researcher_id],
        )?;
        if n == 0 {
            return Err(AccountError::Conflict);
        }
        Ok(())
    }

    /// Check a recovery sign-in secret against the stored verifier.
    pub fn check_recovery(&self, researcher_id: &str, secret: &[u8]) -> Result<bool, AccountError> {
        let verifier: Option<Vec<u8>> = self
            .db()?
            .query_row(
                "SELECT recovery_verifier FROM researchers WHERE id = ?1",
                params![researcher_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let Some(verifier) = verifier else {
            return Ok(false);
        };
        Ok(bool::from(
            Sha256::digest(secret).as_slice().ct_eq(&verifier),
        ))
    }

    // Email sign-in.

    /// Start an email sign-in for the browser holding `request` (a random secret in its cookie).
    /// Returns the code to mail, if there is a researcher with this email. For an unknown email,
    /// a pending sign-in is stored all the same, with a code nobody receives, so both cases look
    /// and behave alike.
    pub fn create_login_code(
        &self,
        site: Site,
        request: &[u8; 32],
        email: &str,
    ) -> Result<Option<String>, AccountError> {
        let db = self.db()?;
        db.execute(
            "DELETE FROM login_codes WHERE expires <= ?1",
            params![now_secs()],
        )?;
        let researcher: Option<String> = match normalize_email(email) {
            Some(email) => db
                .query_row(
                    "SELECT id FROM researchers WHERE email = ?1",
                    params![email],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        let code = new_login_code()?;
        db.execute(
            "INSERT OR REPLACE INTO login_codes (request_hash, researcher_id, code_hash, expires)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                hash(request),
                researcher,
                code_hash(site, request, &code),
                now_secs() + LOGIN_CODE_TTL_SECS
            ],
        )?;
        Ok(researcher.map(|_| code))
    }

    /// Check a sign-in code against the pending sign-in of the browser holding `request`. Returns
    /// the researcher on success. Each pending sign-in works once and allows a few wrong guesses.
    pub fn use_login_code(
        &self,
        site: Site,
        request: &[u8],
        code: &str,
    ) -> Result<String, AccountError> {
        let code: String = code
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .collect();
        let mut db = self.db()?;
        let tx = db.transaction()?;
        let row: Option<(Option<String>, Blob, i64)> = tx
            .query_row(
                "SELECT researcher_id, code_hash, tries FROM login_codes
                 WHERE request_hash = ?1 AND expires > ?2",
                params![hash(request), now_secs()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((researcher, expected, tries)) = row else {
            return Err(AccountError::Forbidden);
        };
        let right = bool::from(code_hash(site, request, &code).as_slice().ct_eq(&expected));
        let result = match researcher {
            Some(id) if right => {
                tx.execute(
                    "DELETE FROM login_codes WHERE request_hash = ?1",
                    params![hash(request)],
                )?;
                Ok(id)
            }
            _ if tries + 1 >= LOGIN_CODE_TRIES => {
                tx.execute(
                    "DELETE FROM login_codes WHERE request_hash = ?1",
                    params![hash(request)],
                )?;
                Err(AccountError::Forbidden)
            }
            _ => {
                tx.execute(
                    "UPDATE login_codes SET tries = tries + 1 WHERE request_hash = ?1",
                    params![hash(request)],
                )?;
                Err(AccountError::Forbidden)
            }
        };
        tx.commit()?;
        result
    }

    // Sessions.

    /// Start a session; returns the cookie value.
    pub fn create_session(
        &self,
        researcher_id: &str,
        site: Site,
        level: Level,
    ) -> Result<String, AccountError> {
        let token = random_token().map_err(|_| AccountError::Internal("random"))?;
        let ttl = match (site, level) {
            (_, Level::Email) => EMAIL_SESSION_TTL_SECS,
            (Site::Keys, Level::Full) => KEYS_SESSION_TTL_SECS,
            (Site::Main, Level::Full) => STUDIO_SESSION_TTL_SECS,
        };
        let level = match level {
            Level::Email => "email",
            Level::Full => "full",
        };
        let db = self.db()?;
        db.execute(
            "DELETE FROM sessions WHERE expires <= ?1",
            params![now_secs()],
        )?;
        db.execute(
            "INSERT INTO sessions (token_hash, researcher_id, site, level, expires)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                hash(&token),
                researcher_id,
                site.as_str(),
                level,
                now_secs() + ttl
            ],
        )?;
        Ok(b64(&token))
    }

    pub fn session(&self, token: &str, site: Site) -> Result<Option<Session>, AccountError> {
        let Ok(token) = decode(token) else {
            return Ok(None);
        };
        let key = hash(&token);
        let row: Option<(String, String)> = self
            .db()?
            .query_row(
                "SELECT researcher_id, level FROM sessions
                 WHERE token_hash = ?1 AND site = ?2 AND expires > ?3",
                params![key, site.as_str(), now_secs()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row.map(|(researcher_id, level)| Session {
            researcher_id,
            site,
            level: if level == "full" {
                Level::Full
            } else {
                Level::Email
            },
            key,
        }))
    }

    /// Replace a session with a fully signed-in one (a new id, so a token seen before the second
    /// step is worthless after it).
    pub fn upgrade_session(&self, session: &Session) -> Result<String, AccountError> {
        self.end_session(session)?;
        self.create_session(&session.researcher_id, session.site, Level::Full)
    }

    pub fn end_session(&self, session: &Session) -> Result<(), AccountError> {
        self.db()?.execute(
            "DELETE FROM sessions WHERE token_hash = ?1",
            params![session.key],
        )?;
        Ok(())
    }

    /// A one-time code that lets the studio start its own session for this researcher.
    pub fn create_handoff(&self, researcher_id: &str) -> Result<String, AccountError> {
        let code = random_token().map_err(|_| AccountError::Internal("random"))?;
        let db = self.db()?;
        db.execute(
            "DELETE FROM handoffs WHERE expires <= ?1",
            params![now_secs()],
        )?;
        db.execute(
            "INSERT INTO handoffs (code_hash, researcher_id, expires) VALUES (?1, ?2, ?3)",
            params![hash(&code), researcher_id, now_secs() + HANDOFF_TTL_SECS],
        )?;
        Ok(b64(&code))
    }

    pub fn use_handoff(&self, code: &str) -> Result<String, AccountError> {
        let code = decode(code)?;
        let mut db = self.db()?;
        let tx = db.transaction()?;
        let id: Option<String> = tx
            .query_row(
                "SELECT researcher_id FROM handoffs WHERE code_hash = ?1 AND expires > ?2",
                params![hash(&code), now_secs()],
                |r| r.get(0),
            )
            .optional()?;
        tx.execute(
            "DELETE FROM handoffs WHERE code_hash = ?1",
            params![hash(&code)],
        )?;
        tx.commit()?;
        id.ok_or(AccountError::Forbidden)
    }

    // Passkeys.

    pub fn passkeys(&self, researcher_id: &str) -> Result<Vec<Passkey>, AccountError> {
        let db = self.db()?;
        let mut stmt = db.prepare("SELECT passkey FROM passkeys WHERE researcher_id = ?1")?;
        let rows: Vec<String> = stmt
            .query_map(params![researcher_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        rows.iter()
            .map(|json| serde_json::from_str(json).map_err(|_| AccountError::Internal("passkey")))
            .collect()
    }

    pub fn add_passkey(
        &self,
        researcher_id: &str,
        passkey: &Passkey,
        name: &str,
    ) -> Result<String, AccountError> {
        let id = b64(passkey.cred_id().as_ref());
        let json = serde_json::to_string(passkey).map_err(|_| AccountError::Internal("passkey"))?;
        let name: String = name.trim().chars().take(60).collect();
        let name = if name.is_empty() {
            "Passkey".to_owned()
        } else {
            name
        };
        let db = self.db()?;
        let count: i64 = db.query_row(
            "SELECT COUNT(*) FROM passkeys WHERE researcher_id = ?1",
            params![researcher_id],
            |r| r.get(0),
        )?;
        if count >= MAX_PASSKEYS {
            return Err(AccountError::Conflict);
        }
        // The same credential cannot belong to two accounts.
        let n = db.execute(
            "INSERT OR IGNORE INTO passkeys (id, researcher_id, passkey, name, created)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, researcher_id, json, name, now_secs()],
        )?;
        if n == 0 {
            return Err(AccountError::Conflict);
        }
        Ok(id)
    }

    /// Record a successful use: the updated counter and the time.
    pub fn passkey_used(&self, researcher_id: &str, passkey: &Passkey) -> Result<(), AccountError> {
        let id = b64(passkey.cred_id().as_ref());
        let json = serde_json::to_string(passkey).map_err(|_| AccountError::Internal("passkey"))?;
        self.db()?.execute(
            "UPDATE passkeys SET passkey = ?1, last_used = ?2 WHERE id = ?3 AND researcher_id = ?4",
            params![json, now_secs(), id, researcher_id],
        )?;
        Ok(())
    }

    pub fn wrapped_master(
        &self,
        researcher_id: &str,
        credential_id: &str,
    ) -> Result<Option<String>, AccountError> {
        let wrapped: Option<Option<Vec<u8>>> = self
            .db()?
            .query_row(
                "SELECT wrapped_master FROM passkeys WHERE id = ?1 AND researcher_id = ?2",
                params![credential_id, researcher_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(wrapped.ok_or(AccountError::NotFound)?.map(|w| b64(&w)))
    }

    pub fn set_wrapped_master(
        &self,
        researcher_id: &str,
        credential_id: &str,
        wrapped: &[u8],
    ) -> Result<(), AccountError> {
        // 12-byte nonce, 32-byte secret, 16-byte tag.
        if wrapped.len() != 60 {
            return Err(AccountError::Invalid);
        }
        let n = self.db()?.execute(
            "UPDATE passkeys SET wrapped_master = ?1 WHERE id = ?2 AND researcher_id = ?3",
            params![wrapped, credential_id, researcher_id],
        )?;
        if n == 0 {
            return Err(AccountError::NotFound);
        }
        Ok(())
    }

    /// Remove a passkey. The last one cannot be removed: the account would be locked.
    pub fn remove_passkey(
        &self,
        researcher_id: &str,
        credential_id: &str,
    ) -> Result<(), AccountError> {
        let mut db = self.db()?;
        let tx = db.transaction()?;
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM passkeys WHERE researcher_id = ?1",
            params![researcher_id],
            |r| r.get(0),
        )?;
        if count <= 1 {
            return Err(AccountError::Conflict);
        }
        let n = tx.execute(
            "DELETE FROM passkeys WHERE id = ?1 AND researcher_id = ?2",
            params![credential_id, researcher_id],
        )?;
        if n == 0 {
            return Err(AccountError::NotFound);
        }
        tx.commit()?;
        Ok(())
    }

    // Projects.

    /// Add a researcher to a project, without access to its key yet. Done by the operator for
    /// the first member, and by members for colleagues.
    pub fn add_member(&self, project: &str, researcher_id: &str) -> Result<(), AccountError> {
        let n = self.db()?.execute(
            "INSERT OR IGNORE INTO members (project, researcher_id, added) VALUES (?1, ?2, ?3)",
            params![project, researcher_id, now_secs()],
        )?;
        if n == 0 {
            return Err(AccountError::Conflict);
        }
        Ok(())
    }

    /// Remove a member and their sealed copy of the project key. The last member with access
    /// cannot be removed, or nobody could open the project's donations again.
    pub fn remove_member(&self, project: &str, researcher_id: &str) -> Result<(), AccountError> {
        let mut db = self.db()?;
        let tx = db.transaction()?;
        let (has_access, others): (bool, i64) = tx
            .query_row(
                "SELECT sealed_ct IS NOT NULL,
                        (SELECT COUNT(*) FROM members m2 WHERE m2.project = ?1
                             AND m2.researcher_id != ?2 AND m2.sealed_ct IS NOT NULL)
                 FROM members WHERE project = ?1 AND researcher_id = ?2",
                params![project, researcher_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(AccountError::NotFound)?;
        if has_access && others == 0 {
            return Err(AccountError::Conflict);
        }
        tx.execute(
            "DELETE FROM members WHERE project = ?1 AND researcher_id = ?2",
            params![project, researcher_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The projects a researcher belongs to, with whether they have access to the key.
    pub fn projects_of(&self, researcher_id: &str) -> Result<Vec<(String, bool)>, AccountError> {
        let db = self.db()?;
        let mut stmt = db.prepare(
            "SELECT project, sealed_ct IS NOT NULL FROM members
             WHERE researcher_id = ?1 ORDER BY project",
        )?;
        let rows = stmt
            .query_map(params![researcher_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Whether the researcher is a member, and whether they have access to the project key.
    pub fn membership(
        &self,
        project: &str,
        researcher_id: &str,
    ) -> Result<Option<bool>, AccountError> {
        Ok(self
            .db()?
            .query_row(
                "SELECT sealed_ct IS NOT NULL FROM members WHERE project = ?1 AND researcher_id = ?2",
                params![project, researcher_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn members(&self, project: &str) -> Result<Vec<MemberInfo>, AccountError> {
        let db = self.db()?;
        let mut stmt = db.prepare(
            "SELECT m.researcher_id, r.email, r.public_key, m.sealed_ct IS NOT NULL, m.added
             FROM members m JOIN researchers r ON r.id = m.researcher_id
             WHERE m.project = ?1 ORDER BY m.added",
        )?;
        let rows = stmt
            .query_map(params![project], |r| {
                Ok(MemberInfo {
                    researcher_id: r.get(0)?,
                    email: r.get(1)?,
                    public_key: r.get::<_, Option<Vec<u8>>>(2)?.map(|k| b64(&k)),
                    has_access: r.get(3)?,
                    added: r.get(4)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn project_key(&self, project: &str) -> Result<Option<ProjectKeyInfo>, AccountError> {
        Ok(self
            .db()?
            .query_row(
                "SELECT public_key, fingerprint, created FROM project_keys WHERE project = ?1",
                params![project],
                |r| {
                    Ok(ProjectKeyInfo {
                        public_key: b64(&r.get::<_, Vec<u8>>(0)?),
                        fingerprint: r.get(1)?,
                        created: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Set the project key, once, together with the creating member's sealed copy.
    pub fn create_project_key(
        &self,
        project: &str,
        researcher_id: &str,
        public_key: &[u8],
        fingerprint: &str,
        sealed_enc: &[u8],
        sealed_ct: &[u8],
    ) -> Result<(), AccountError> {
        if public_key.len() != PUBLIC_KEY_BYTES
            || fingerprint.len() > 64
            || sealed_enc.len() > MAX_SEALED_BYTES
            || sealed_ct.len() > MAX_SEALED_BYTES
        {
            return Err(AccountError::Invalid);
        }
        let mut db = self.db()?;
        let tx = db.transaction()?;
        let member = tx
            .query_row(
                "SELECT 1 FROM members WHERE project = ?1 AND researcher_id = ?2",
                params![project, researcher_id],
                |_| Ok(()),
            )
            .optional()?;
        if member.is_none() {
            return Err(AccountError::Forbidden);
        }
        let n = tx.execute(
            "INSERT OR IGNORE INTO project_keys (project, public_key, fingerprint, created)
             VALUES (?1, ?2, ?3, ?4)",
            params![project, public_key, fingerprint, now_secs()],
        )?;
        if n == 0 {
            return Err(AccountError::Conflict);
        }
        tx.execute(
            "UPDATE members SET sealed_enc = ?1, sealed_ct = ?2 WHERE project = ?3 AND researcher_id = ?4",
            params![sealed_enc, sealed_ct, project, researcher_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn sealed_project_key(
        &self,
        project: &str,
        researcher_id: &str,
    ) -> Result<Option<SealedKey>, AccountError> {
        let row: Option<(Option<Blob>, Option<Blob>)> = self
            .db()?
            .query_row(
                "SELECT sealed_enc, sealed_ct FROM members WHERE project = ?1 AND researcher_id = ?2",
                params![project, researcher_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            Some((Some(enc), Some(ct))) => Some(SealedKey {
                enc: b64(&enc),
                ciphertext: b64(&ct),
            }),
            _ => None,
        })
    }

    /// Give a member access: store the project key sealed to their personal key. The granting
    /// researcher must have access themselves; the sealing happened in their browser.
    pub fn grant(
        &self,
        project: &str,
        granter: &str,
        member: &str,
        sealed_enc: &[u8],
        sealed_ct: &[u8],
    ) -> Result<(), AccountError> {
        if sealed_enc.len() > MAX_SEALED_BYTES || sealed_ct.len() > MAX_SEALED_BYTES {
            return Err(AccountError::Invalid);
        }
        if self.membership(project, granter)? != Some(true) {
            return Err(AccountError::Forbidden);
        }
        let n = self.db()?.execute(
            "UPDATE members SET sealed_enc = ?1, sealed_ct = ?2
             WHERE project = ?3 AND researcher_id = ?4 AND sealed_ct IS NULL
               AND (SELECT public_key FROM researchers WHERE id = ?4) IS NOT NULL",
            params![sealed_enc, sealed_ct, project, member],
        )?;
        if n == 0 {
            return Err(AccountError::Conflict);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accounts() -> (tempfile::TempDir, Accounts) {
        let dir = tempfile::tempdir().unwrap();
        let accounts = Accounts::open(&dir.path().join("research.sqlite")).unwrap();
        (dir, accounts)
    }

    #[test]
    fn emails_are_normalised() {
        assert_eq!(
            normalize_email("  Ada@Uni.NL "),
            Some("ada@uni.nl".to_owned())
        );
        assert_eq!(normalize_email("no-at-sign"), None);
        assert_eq!(normalize_email("a@nodot"), None);
        assert_eq!(normalize_email("a b@uni.nl"), None);
    }

    #[test]
    fn login_codes_work_once_only_in_the_browser_that_asked() {
        let (_dir, a) = accounts();
        let id = a.add_researcher("ada@uni.nl").unwrap();
        assert_eq!(a.add_researcher("ADA@uni.nl").unwrap(), id);

        let unknown = [1u8; 32];
        assert_eq!(a.create_login_code(Site::Keys, &unknown, "nobody@uni.nl").unwrap(), None);
        assert_eq!(
            a.use_login_code(Site::Keys, &unknown, "00000000"),
            Err(AccountError::Forbidden)
        );

        let browser = [2u8; 32];
        let code = a.create_login_code(Site::Keys, &browser, "Ada@uni.nl").unwrap().unwrap();
        assert_eq!(code.len(), 8);
        assert!(code.bytes().all(|b| b.is_ascii_digit()));
        // Another browser cannot use the code.
        assert_eq!(
            a.use_login_code(Site::Keys, &[3u8; 32], &code),
            Err(AccountError::Forbidden)
        );
        // Spaces and dashes are fine; it works once.
        let typed = format!("{} {}", &code[..4], &code[4..]);
        // Nor can the other site.
        assert_eq!(
            a.use_login_code(Site::Main, &browser, &code),
            Err(AccountError::Forbidden)
        );
        assert_eq!(a.use_login_code(Site::Keys, &browser, &typed).unwrap(), id);
        assert_eq!(
            a.use_login_code(Site::Keys, &browser, &code),
            Err(AccountError::Forbidden)
        );
    }

    #[test]
    fn login_codes_stop_working_after_a_few_wrong_tries() {
        let (_dir, a) = accounts();
        a.add_researcher("ada@uni.nl").unwrap();
        let browser = [2u8; 32];
        let code = a.create_login_code(Site::Keys, &browser, "ada@uni.nl").unwrap().unwrap();
        let wrong = if code == "00000000" { "11111111" } else { "00000000" };
        for _ in 0..LOGIN_CODE_TRIES {
            assert_eq!(
                a.use_login_code(Site::Keys, &browser, wrong),
                Err(AccountError::Forbidden)
            );
        }
        assert_eq!(
            a.use_login_code(Site::Keys, &browser, &code),
            Err(AccountError::Forbidden)
        );
    }

    #[test]
    fn sessions_belong_to_one_site_and_upgrade_to_a_new_id() {
        let (_dir, a) = accounts();
        let id = a.add_researcher("ada@uni.nl").unwrap();
        let token = a.create_session(&id, Site::Keys, Level::Email).unwrap();
        assert!(a.session(&token, Site::Main).unwrap().is_none());
        let session = a.session(&token, Site::Keys).unwrap().unwrap();
        assert_eq!(session.level, Level::Email);
        let full = a.upgrade_session(&session).unwrap();
        assert!(a.session(&token, Site::Keys).unwrap().is_none());
        assert_eq!(
            a.session(&full, Site::Keys).unwrap().unwrap().level,
            Level::Full
        );
    }

    #[test]
    fn the_personal_key_is_set_once_and_checks_recovery() {
        let (_dir, a) = accounts();
        let id = a.add_researcher("ada@uni.nl").unwrap();
        let secret = [7u8; 32];
        let verifier = Sha256::digest(secret);
        a.set_personal_key(&id, &[1; PUBLIC_KEY_BYTES], &verifier)
            .unwrap();
        assert_eq!(
            a.set_personal_key(&id, &[2; PUBLIC_KEY_BYTES], &verifier),
            Err(AccountError::Conflict)
        );
        assert!(a.check_recovery(&id, &secret).unwrap());
        assert!(!a.check_recovery(&id, &[8u8; 32]).unwrap());
        a.reset_researcher_key("ada@uni.nl").unwrap();
        assert!(a.me(&id).unwrap().public_key.is_none());
    }

    #[test]
    fn project_keys_are_created_once_and_granted_by_members_with_access() {
        let (_dir, a) = accounts();
        let ada = a.add_researcher("ada@uni.nl").unwrap();
        let bob = a.add_researcher("bob@uni.nl").unwrap();
        let eve = a.add_researcher("eve@uni.nl").unwrap();
        a.add_member("willow", &ada).unwrap();
        a.add_member("willow", &bob).unwrap();
        let pk = [3u8; PUBLIC_KEY_BYTES];
        assert_eq!(
            a.create_project_key("willow", &eve, &pk, "fp", b"e", b"c"),
            Err(AccountError::Forbidden)
        );
        a.create_project_key("willow", &ada, &pk, "fp", b"e", b"c")
            .unwrap();
        assert_eq!(
            a.create_project_key("willow", &bob, &pk, "fp", b"e", b"c"),
            Err(AccountError::Conflict)
        );
        assert_eq!(a.membership("willow", &ada).unwrap(), Some(true));
        assert_eq!(a.membership("willow", &bob).unwrap(), Some(false));

        // Bob has no personal key yet, and Eve is not a member with access.
        assert_eq!(
            a.grant("willow", &ada, &bob, b"e2", b"c2"),
            Err(AccountError::Conflict)
        );
        a.set_personal_key(&bob, &[4; PUBLIC_KEY_BYTES], &[0; 32])
            .unwrap();
        assert_eq!(
            a.grant("willow", &eve, &bob, b"e2", b"c2"),
            Err(AccountError::Forbidden)
        );
        a.grant("willow", &ada, &bob, b"e2", b"c2").unwrap();
        assert_eq!(
            a.sealed_project_key("willow", &bob).unwrap().unwrap().enc,
            b64(b"e2")
        );

        // Removing members, but never the last one with access.
        a.remove_member("willow", &bob).unwrap();
        assert_eq!(a.remove_member("willow", &ada), Err(AccountError::Conflict));
    }
}
