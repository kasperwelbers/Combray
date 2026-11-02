//! Researcher sign-in, project keys and donations, through the HTTP API. Passkey ceremonies need
//! an authenticator and are covered by the key page's browser test (apps/keys/test/e2e.mjs);
//! here a researcher reaches a full session with the recovery code instead.

use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use combray_server::accounts::{Accounts, PUBLIC_KEY_BYTES};
use combray_server::keys::{Argon2Cost, RateLimits};
use combray_server::mail::MailConfig;
use combray_server::{Config, ResearchConfig, app};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const MAIN: &str = "combray.test";
const KEYS: &str = "keys.combray.test";

struct Fixture {
    dir: tempfile::TempDir,
    app: Router,
    research_db: PathBuf,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let web = dir.path().join("web");
        let data = dir.path().join("data");
        std::fs::create_dir_all(&web).unwrap();
        std::fs::create_dir_all(data.join("projects")).unwrap();
        std::fs::write(
            web.join("index.html"),
            "<!doctype html><title>Combray</title>",
        )
        .unwrap();
        std::fs::write(
            data.join("projects/willow.json"),
            r#"{"id":"willow","name":{"en":"Willow study"}}"#,
        )
        .unwrap();
        let keys_page = dir.path().join("keys.html");
        std::fs::write(
            &keys_page,
            "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'sha256-abc'\"><title>Keys</title>",
        )
        .unwrap();
        let research_db = data.join("research.sqlite");
        let config = Config {
            web_dir: web,
            db_path: data.join("combray.sqlite"),
            store_master_key_file: dir.path().join("secrets/store-master.key"),
            client_ip_header: None,
            argon2: Argon2Cost {
                m_kib: 64,
                t: 1,
                p: 1,
            },
            rate_limits: RateLimits::default(),
            research: Some(ResearchConfig {
                public_url: format!("http://{MAIN}").parse().unwrap(),
                keys_url: format!("http://{KEYS}").parse().unwrap(),
                keys_page,
                research_db: research_db.clone(),
                donation_keys_db: dir.path().join("keys/donation-keys.sqlite"),
                mail: MailConfig::Outbox(dir.path().join("outbox")),
                max_donation_bytes: 1024 * 1024,
                key_backup_retention_days: 30,
            }),
            data_dir: data,
        };
        Fixture {
            app: app(config).unwrap(),
            research_db,
            dir,
        }
    }

    /// A second handle on the accounts database, for setting up state the API only allows
    /// after a passkey ceremony.
    fn accounts(&self) -> Accounts {
        Accounts::open(&self.research_db).unwrap()
    }

    fn outbox(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.dir.path().join("outbox")) else {
            return vec![];
        };
        entries
            .map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap())
            .collect()
    }

    async fn call(&self, r: Call<'_>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut request = Request::builder()
            .method(r.method.clone())
            .uri(r.uri)
            .header(header::HOST, r.host);
        if let Some(origin) = r.origin {
            request = request.header(header::ORIGIN, origin);
        }
        if let Some(cookie) = r.cookie {
            request = request.header(header::COOKIE, format!("combray={cookie}"));
        }
        if let Some(site) = r.fetch_site {
            request = request.header("sec-fetch-site", site);
        }
        let body = match r.body {
            Some(Payload::Json(v)) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(v.to_string())
            }
            Some(Payload::Bytes(b)) => Body::from(b),
            None => Body::empty(),
        };
        let response = self
            .app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        (status, headers, body)
    }

    /// A same-origin JSON request to one of the sites.
    async fn json(
        &self,
        method: Method,
        host: &str,
        uri: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let origin = format!("http://{host}");
        let (status, headers, body) = self
            .call(Call {
                method,
                host,
                uri,
                origin: Some(&origin),
                cookie,
                fetch_site: Some("same-origin"),
                body: body.map(Payload::Json),
            })
            .await;
        (
            status,
            headers,
            serde_json::from_slice(&body).unwrap_or(Value::Null),
        )
    }
}

enum Payload {
    Json(Value),
    Bytes(Vec<u8>),
}

struct Call<'a> {
    method: Method,
    host: &'a str,
    uri: &'a str,
    origin: Option<&'a str>,
    cookie: Option<&'a str>,
    fetch_site: Option<&'a str>,
    body: Option<Payload>,
}

fn set_cookie(headers: &HeaderMap) -> String {
    let cookie = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(
        cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"),
        "{cookie}"
    );
    cookie
        .split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .to_owned()
}

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Sign in through the email link, then with the recovery secret. Returns the key page cookie.
async fn sign_in(f: &Fixture, email: &str, secret: &[u8]) -> String {
    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/email",
            None,
            Some(json!({ "email": email })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let token = wait_for_link(f, email).await;
    let (status, headers, body) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/email/verify",
            None,
            Some(json!({ "token": token })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let email_cookie = set_cookie(&headers);
    let (status, headers, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/recovery",
            Some(&email_cookie),
            Some(json!({ "secret": b64(secret) })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let full = set_cookie(&headers);
    assert_ne!(
        full, email_cookie,
        "the session id changes when sign-in completes"
    );
    full
}

async fn wait_for_link(f: &Fixture, email: &str) -> String {
    for _ in 0..100 {
        if let Some(mail) = f
            .outbox()
            .into_iter()
            .rev()
            .find(|m| m.starts_with(&format!("To: {email}\n")) && m.contains("#login="))
        {
            let token = mail
                .split("#login=")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap()
                .to_owned();
            // Use each mail once.
            for entry in std::fs::read_dir(f.dir.path().join("outbox")).unwrap() {
                let path = entry.unwrap().path();
                if std::fs::read_to_string(&path).unwrap() == mail {
                    std::fs::remove_file(path).unwrap();
                }
            }
            return token;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("no sign-in mail for {email}");
}

/// A researcher with a personal key and a known recovery secret.
fn researcher(f: &Fixture, email: &str, secret: &[u8]) -> String {
    let accounts = f.accounts();
    let id = accounts.add_researcher(email).unwrap();
    accounts
        .set_personal_key(
            &id,
            &[id.len() as u8; PUBLIC_KEY_BYTES],
            &Sha256::digest(secret),
        )
        .unwrap();
    id
}

fn envelope(project: &str, donation: &str, key: &str) -> Vec<u8> {
    let header = json!({ "v": 1, "project": project, "donation": donation, "key": key, "chunks": 1, "chunkBytes": 1024, "created": "2026-11-02" }).to_string();
    let mut out = b"CMBRDON1".to_vec();
    out.extend_from_slice(&(header.len() as u32).to_be_bytes());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(&[0, 0, 0, 4, 1, 2, 3, 4]);
    out
}

fn donation_body(sealed: Value, envelope: &[u8]) -> Vec<u8> {
    let meta = sealed.to_string();
    let mut out = (meta.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(meta.as_bytes());
    out.extend_from_slice(envelope);
    out
}

async fn donate(f: &Fixture, body: Vec<u8>) -> (StatusCode, Value) {
    let main_origin = format!("http://{MAIN}");
    let (status, _, body) = f
        .call(Call {
            method: Method::POST,
            host: MAIN,
            uri: "/api/v1/p/willow/donations",
            origin: Some(&main_origin),
            cookie: None,
            fetch_site: Some("same-origin"),
            body: Some(Payload::Bytes(body)),
        })
        .await;
    (
        status,
        serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null),
    )
}

async fn withdraw(f: &Fixture, id: &str, token: String) -> StatusCode {
    let main_origin = format!("http://{MAIN}");
    f.call(Call {
        method: Method::POST,
        host: MAIN,
        uri: &format!("/api/v1/donations/{id}/withdraw"),
        origin: Some(&main_origin),
        cookie: None,
        fetch_site: Some("same-origin"),
        body: Some(Payload::Json(json!({ "token": token }))),
    })
    .await
    .0
}

#[tokio::test]
async fn the_key_page_is_served_only_on_its_own_host() {
    let f = Fixture::new();
    let (status, headers, body) = f
        .call(Call {
            method: Method::GET,
            host: KEYS,
            uri: "/",
            origin: None,
            cookie: None,
            fetch_site: None,
            body: None,
        })
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        String::from_utf8(body)
            .unwrap()
            .contains("<title>Keys</title>")
    );
    assert_eq!(
        headers[header::CONTENT_SECURITY_POLICY],
        "default-src 'none'; script-src 'sha256-abc'; frame-ancestors 'none'"
    );
    assert!(
        headers["permissions-policy"]
            .to_str()
            .unwrap()
            .contains("publickey-credentials-get=(self)")
    );

    // Nothing else on the key page's host: not the participant app, not the store service.
    for uri in ["/willow/", "/studio/", "/api/v1/stores"] {
        let (status, _, _) = f
            .call(Call {
                method: Method::GET,
                host: KEYS,
                uri,
                origin: None,
                cookie: None,
                fetch_site: None,
                body: None,
            })
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
    }

    // The main site cannot use passkeys, and has no sign-in or key routes.
    let (status, headers, _) = f
        .json(Method::GET, MAIN, "/api/v1/health", None, None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers["permissions-policy"]
            .to_str()
            .unwrap()
            .contains("publickey-credentials-get=()")
    );
    for uri in [
        "/api/v1/auth/email",
        "/api/v1/auth/passkey/start",
        "/api/v1/projects/willow/donation-keys",
    ] {
        let (status, _, _) = f.json(Method::POST, MAIN, uri, None, Some(json!({}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
    }

    let (_, _, site) = f.json(Method::GET, MAIN, "/api/v1/site", None, None).await;
    assert_eq!(site["keys_url"], format!("http://{KEYS}"));
}

#[tokio::test]
async fn email_links_go_only_to_known_researchers_and_work_once() {
    let f = Fixture::new();
    f.accounts().add_researcher("ada@uni.nl").unwrap();

    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/email",
            None,
            Some(json!({ "email": "nobody@uni.nl" })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "the same answer for unknown emails"
    );

    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/email",
            None,
            Some(json!({ "email": "Ada@Uni.nl" })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let token = wait_for_link(&f, "ada@uni.nl").await;
    assert!(f.outbox().iter().all(|m| !m.contains("nobody@uni.nl")));

    let (status, headers, body) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/email/verify",
            None,
            Some(json!({ "token": token })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "email": "ada@uni.nl", "has_passkey": false, "has_key": false })
    );
    let cookie = set_cookie(&headers);

    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/email/verify",
            None,
            Some(json!({ "token": token })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a link works once");

    // The email link alone is not a sign-in.
    let (_, _, me) = f
        .json(Method::GET, KEYS, "/api/v1/me", Some(&cookie), None)
        .await;
    assert_eq!(me["signed_in"], false);
    let (status, _, _) = f
        .json(Method::GET, KEYS, "/api/v1/projects", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/handoff",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // It does allow registering the first passkey, bound to the key page's host name.
    let (status, _, options) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/passkey/register/start",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(options["publicKey"]["rp"]["id"], KEYS);
    assert_eq!(
        options["publicKey"]["authenticatorSelection"]["userVerification"],
        "required"
    );

    // A key page cookie means nothing on the main site.
    let (status, _, _) = f
        .json(Method::GET, MAIN, "/api/v1/me", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn sign_in_emails_are_rate_limited_per_address() {
    let f = Fixture::new();
    for _ in 0..3 {
        let (status, _, _) = f
            .json(
                Method::POST,
                KEYS,
                "/api/v1/auth/email",
                None,
                Some(json!({ "email": "ada@uni.nl" })),
            )
            .await;
        assert_eq!(status, StatusCode::ACCEPTED);
    }
    let (status, headers, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/email",
            None,
            Some(json!({ "email": "ada@uni.nl" })),
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(headers.contains_key(header::RETRY_AFTER));
}

#[tokio::test]
async fn requests_from_other_origins_are_refused() {
    let f = Fixture::new();
    let secret = [9u8; 32];
    researcher(&f, "ada@uni.nl", &secret);
    let cookie = sign_in(&f, "ada@uni.nl", &secret).await;

    // A page on the main site trying to use the key page's session.
    let main_origin = format!("http://{MAIN}");
    let (status, _, _) = f
        .call(Call {
            method: Method::POST,
            host: KEYS,
            uri: "/api/v1/auth/handoff",
            origin: Some(&main_origin),
            cookie: Some(&cookie),
            fetch_site: Some("same-site"),
            body: None,
        })
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = f
        .call(Call {
            method: Method::GET,
            host: KEYS,
            uri: "/api/v1/projects",
            origin: None,
            cookie: Some(&cookie),
            fetch_site: Some("same-site"),
            body: None,
        })
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // State changes need an Origin header.
    let (status, _, _) = f
        .call(Call {
            method: Method::POST,
            host: KEYS,
            uri: "/api/v1/auth/handoff",
            origin: None,
            cookie: Some(&cookie),
            fetch_site: None,
            body: None,
        })
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn recovery_sign_in_needs_the_right_secret() {
    let f = Fixture::new();
    researcher(&f, "ada@uni.nl", &[1u8; 32]);
    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/email",
            None,
            Some(json!({ "email": "ada@uni.nl" })),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let token = wait_for_link(&f, "ada@uni.nl").await;
    let (_, headers, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/email/verify",
            None,
            Some(json!({ "token": token })),
        )
        .await;
    let cookie = set_cookie(&headers);
    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/recovery",
            Some(&cookie),
            Some(json!({ "secret": b64(&[2u8; 32]) })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    for _ in 0..4 {
        f.json(
            Method::POST,
            KEYS,
            "/api/v1/auth/recovery",
            Some(&cookie),
            Some(json!({ "secret": b64(&[2u8; 32]) })),
        )
        .await;
    }
    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/recovery",
            Some(&cookie),
            Some(json!({ "secret": b64(&[1u8; 32]) })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "attempts are limited per researcher"
    );
}

#[tokio::test]
async fn the_studio_signs_in_through_a_handoff_and_never_sees_keys() {
    let f = Fixture::new();
    let secret = [3u8; 32];
    let ada = researcher(&f, "ada@uni.nl", &secret);
    f.accounts().add_member("willow", &ada).unwrap();
    let keys_cookie = sign_in(&f, "ada@uni.nl", &secret).await;

    let (status, _, body) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/auth/handoff",
            Some(&keys_cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let code = body["code"].as_str().unwrap().to_owned();
    let (status, headers, _) = f
        .json(
            Method::POST,
            MAIN,
            "/api/v1/auth/handoff/redeem",
            None,
            Some(json!({ "code": code })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let studio = set_cookie(&headers);
    let (status, _, _) = f
        .json(
            Method::POST,
            MAIN,
            "/api/v1/auth/handoff/redeem",
            None,
            Some(json!({ "code": code })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a handoff code works once");

    let (_, _, me) = f
        .json(Method::GET, MAIN, "/api/v1/me", Some(&studio), None)
        .await;
    assert_eq!(
        (me["email"].as_str(), me["signed_in"].as_bool()),
        (Some("ada@uni.nl"), Some(true))
    );
    let (_, _, projects) = f
        .json(Method::GET, MAIN, "/api/v1/projects", Some(&studio), None)
        .await;
    assert_eq!(projects["projects"][0]["id"], "willow");

    // Set up the project key on the key page, then check what each site gets.
    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/projects/willow/key",
            Some(&keys_cookie),
            Some(json!({ "public_key": b64(&[5; PUBLIC_KEY_BYTES]), "fingerprint": "fp-willow", "sealed_key": { "enc": "ZQ", "ciphertext": "Yw" } })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, _, on_keys) = f
        .json(
            Method::GET,
            KEYS,
            "/api/v1/projects/willow",
            Some(&keys_cookie),
            None,
        )
        .await;
    assert_eq!(on_keys["sealed_key"]["enc"], "ZQ");
    let (_, _, on_main) = f
        .json(
            Method::GET,
            MAIN,
            "/api/v1/projects/willow",
            Some(&studio),
            None,
        )
        .await;
    assert_eq!(on_main["sealed_key"], Value::Null);
    assert_eq!(on_main["key"]["fingerprint"], "fp-willow");

    // The studio cookie is not a key page cookie.
    let (status, _, _) = f
        .json(Method::GET, KEYS, "/api/v1/me", Some(&studio), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn members_grant_access_and_only_members_with_access_fetch_keys() {
    let f = Fixture::new();
    let ada = researcher(&f, "ada@uni.nl", &[1u8; 32]);
    f.accounts().add_member("willow", &ada).unwrap();
    let ada_cookie = sign_in(&f, "ada@uni.nl", &[1u8; 32]).await;
    f.json(
        Method::POST,
        KEYS,
        "/api/v1/projects/willow/key",
        Some(&ada_cookie),
        Some(json!({ "public_key": b64(&[5; PUBLIC_KEY_BYTES]), "fingerprint": "fp", "sealed_key": { "enc": "ZQ", "ciphertext": "Yw" } })),
    )
    .await;

    // Ada adds Bob, who gets an account and an email, but no access yet.
    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/projects/willow/members",
            Some(&ada_cookie),
            Some(json!({ "email": "bob@uni.nl" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let bob_id = f.accounts().add_researcher("bob@uni.nl").unwrap();
    f.accounts()
        .set_personal_key(&bob_id, &[7; PUBLIC_KEY_BYTES], &Sha256::digest([2u8; 32]))
        .unwrap();
    let bob_cookie = sign_in(&f, "bob@uni.nl", &[2u8; 32]).await;
    let (status, _, _) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/projects/willow/donation-keys",
            Some(&bob_cookie),
            Some(json!({ "ids": [] })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a member without access cannot fetch keys"
    );
    let (_, _, project) = f
        .json(
            Method::GET,
            KEYS,
            "/api/v1/projects/willow",
            Some(&ada_cookie),
            None,
        )
        .await;
    let bob = project["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == "bob@uni.nl")
        .unwrap();
    assert_eq!(bob["has_access"], false);
    assert_eq!(
        bob["public_key"],
        b64(&[7; PUBLIC_KEY_BYTES]),
        "Ada's browser seals the key to this"
    );

    let grant = format!("/api/v1/projects/willow/members/{bob_id}/key");
    let (status, _, _) = f
        .json(
            Method::PUT,
            KEYS,
            &grant,
            Some(&bob_cookie),
            Some(json!({ "enc": "ZQ", "ciphertext": "Yw" })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "only members with access can grant"
    );
    let (status, _, _) = f
        .json(
            Method::PUT,
            KEYS,
            &grant,
            Some(&ada_cookie),
            Some(json!({ "enc": "Ym9i", "ciphertext": "Ym9i" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _, _) = f
        .json(
            Method::PUT,
            KEYS,
            &grant,
            Some(&ada_cookie),
            Some(json!({ "enc": "eHg", "ciphertext": "eHg" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "a grant is not overwritten");
    let (_, _, project) = f
        .json(
            Method::GET,
            KEYS,
            "/api/v1/projects/willow",
            Some(&bob_cookie),
            None,
        )
        .await;
    assert_eq!(project["sealed_key"]["enc"], "Ym9i");

    // Strangers see nothing.
    researcher(&f, "eve@uni.nl", &[4u8; 32]);
    let eve = sign_in(&f, "eve@uni.nl", &[4u8; 32]).await;
    let (status, _, _) = f
        .json(
            Method::GET,
            KEYS,
            "/api/v1/projects/willow",
            Some(&eve),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn donations_are_stored_fetched_on_use_and_withdrawn() {
    let f = Fixture::new();
    let ada = researcher(&f, "ada@uni.nl", &[1u8; 32]);
    f.accounts().add_member("willow", &ada).unwrap();
    let cookie = sign_in(&f, "ada@uni.nl", &[1u8; 32]).await;

    let id = "AAAAAAAAAAAAAAAAAAAAAA";
    let sealed = json!({ "enc": b64(&[1; 1120]), "ciphertext": b64(&[2; 48]) });
    // No project key yet: nothing can be donated.
    let (status, _) = donate(
        &f,
        donation_body(sealed.clone(), &envelope("willow", id, "fp")),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    f.json(
        Method::POST,
        KEYS,
        "/api/v1/projects/willow/key",
        Some(&cookie),
        Some(json!({ "public_key": b64(&[5; PUBLIC_KEY_BYTES]), "fingerprint": "fp", "sealed_key": { "enc": "ZQ", "ciphertext": "Yw" } })),
    )
    .await;
    let (_, _, config) = f
        .json(Method::GET, MAIN, "/api/v1/p/willow/config", None, None)
        .await;
    assert_eq!(config["donation_key"]["fingerprint"], "fp");
    assert_eq!(config["donation_key"]["withdrawal_complete_days"], 30);

    // Envelopes for another project or key are refused.
    let (status, _) = donate(
        &f,
        donation_body(sealed.clone(), &envelope("oak", id, "fp")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = donate(
        &f,
        donation_body(sealed.clone(), &envelope("willow", id, "other-key")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let env = envelope("willow", id, "fp");
    let (status, receipt) = donate(&f, donation_body(sealed.clone(), &env)).await;
    assert_eq!(status, StatusCode::CREATED, "{receipt}");
    assert_eq!(receipt["donation"], id);
    let token = receipt["withdrawal_token"].as_str().unwrap().to_owned();
    let (status, _) = donate(&f, donation_body(sealed.clone(), &env)).await;
    assert_eq!(status, StatusCode::CONFLICT, "ids are not reused");

    let (_, _, list) = f
        .json(
            Method::GET,
            KEYS,
            "/api/v1/projects/willow/donations",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(list["donations"][0]["id"], id);
    let (status, headers, bytes) = f
        .call(Call {
            method: Method::GET,
            host: KEYS,
            uri: &format!("/api/v1/projects/willow/donations/{id}"),
            origin: None,
            cookie: Some(&cookie),
            fetch_site: Some("same-origin"),
            body: None,
        })
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, env);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    let (_, headers, keys) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/projects/willow/donation-keys",
            Some(&cookie),
            Some(json!({ "ids": [id] })),
        )
        .await;
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(keys["keys"][0]["enc"], sealed["enc"]);

    // The participant withdraws: the key is gone, a tombstone remains.
    assert_eq!(withdraw(&f, id, b64(&[0; 32])).await, StatusCode::FORBIDDEN);
    assert_eq!(withdraw(&f, id, token).await, StatusCode::NO_CONTENT);
    let (_, _, keys) = f
        .json(
            Method::POST,
            KEYS,
            "/api/v1/projects/willow/donation-keys",
            Some(&cookie),
            Some(json!({ "ids": [id] })),
        )
        .await;
    assert_eq!(keys["keys"], json!([]));
    let (_, _, list) = f
        .json(
            Method::GET,
            KEYS,
            "/api/v1/projects/willow/donations",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(list["donations"], json!([]));
    assert_eq!(list["withdrawn"][0]["id"], id);
}

#[tokio::test]
async fn researchers_withdraw_on_a_participants_behalf() {
    let f = Fixture::new();
    let ada = researcher(&f, "ada@uni.nl", &[1u8; 32]);
    f.accounts().add_member("willow", &ada).unwrap();
    let cookie = sign_in(&f, "ada@uni.nl", &[1u8; 32]).await;
    f.json(
        Method::POST,
        KEYS,
        "/api/v1/projects/willow/key",
        Some(&cookie),
        Some(json!({ "public_key": b64(&[5; PUBLIC_KEY_BYTES]), "fingerprint": "fp", "sealed_key": { "enc": "ZQ", "ciphertext": "Yw" } })),
    )
    .await;
    let id = "BBBBBBBBBBBBBBBBBBBBBB";
    let main_origin = format!("http://{MAIN}");
    let (status, _, _) = f
        .call(Call {
            method: Method::POST,
            host: MAIN,
            uri: "/api/v1/p/willow/donations",
            origin: Some(&main_origin),
            cookie: None,
            fetch_site: Some("same-origin"),
            body: Some(Payload::Bytes(donation_body(
                json!({ "enc": "ZQ", "ciphertext": "Yw" }),
                &envelope("willow", id, "fp"),
            ))),
        })
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _, _) = f
        .json(
            Method::DELETE,
            KEYS,
            &format!("/api/v1/projects/willow/donations/{id}"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, _, list) = f
        .json(
            Method::GET,
            KEYS,
            "/api/v1/projects/willow/donations",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(list["withdrawn"][0]["id"], id);
}
