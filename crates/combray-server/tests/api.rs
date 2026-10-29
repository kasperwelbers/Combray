use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderName, Request, StatusCode, header};
use combray_server::keys::{Argon2Cost, RateLimits};
use combray_server::{CSP, Config, app};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Fixture {
    _dir: tempfile::TempDir,
    config: Config,
    app: Router,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let web = dir.path().join("web");
    let data = dir.path().join("data");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::create_dir_all(data.join("projects")).unwrap();
    std::fs::write(
        web.join("index.html"),
        "<!doctype html><title>Combray</title>",
    )
    .unwrap();
    std::fs::write(web.join("assets/app.js"), "console.log(1)").unwrap();
    std::fs::write(
        data.join("projects/willow.json"),
        r#"{"id":"willow","name":"Willow study"}"#,
    )
    .unwrap();
    std::fs::write(
        data.join("projects/oak.json"),
        r#"{"id":"oak","participants":{"mode":"required","pattern":"P[0-9]{4}"}}"#,
    )
    .unwrap();
    std::fs::write(
        data.join("projects/elm.json"),
        r#"{"id":"elm","participants":{"mode":"anonymous"}}"#,
    )
    .unwrap();
    std::fs::write(data.join("projects/broken.json"), "{not json").unwrap();
    let config = Config {
        web_dir: web,
        db_path: data.join("combray.sqlite"),
        store_master_key_file: dir.path().join("secrets/store-master.key"),
        data_dir: data,
        client_ip_header: Some(HeaderName::from_static("x-forwarded-for")),
        // Cheap hashing keeps the tests fast; production uses the OWASP default.
        argon2: Argon2Cost {
            m_kib: 64,
            t: 1,
            p: 1,
        },
        rate_limits: RateLimits {
            attempts: 30,
            creates: 3,
            window: Duration::from_secs(600),
        },
    };
    Fixture {
        app: app(config.clone()).unwrap(),
        config,
        _dir: dir,
    }
}

async fn send(f: &Fixture, request: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
    let response = f.app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8_lossy(&body).into_owned())
}

async fn get(f: &Fixture, uri: &str) -> (StatusCode, axum::http::HeaderMap, String) {
    send(f, Request::get(uri).body(Body::empty()).unwrap()).await
}

async fn post(
    f: &Fixture,
    uri: &str,
    ip: &str,
    body: Value,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let request = Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", format!("10.0.0.1, {ip}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, headers, body) = send(f, request).await;
    (
        status,
        headers,
        serde_json::from_str(&body).unwrap_or(Value::Null),
    )
}

async fn create(f: &Fixture, password: &str) -> (String, String) {
    let (id, kek, _) = create_full(f, password).await;
    (id, kek)
}

async fn create_full(f: &Fixture, password: &str) -> (String, String, String) {
    let (status, headers, body) = post(
        f,
        "/api/v1/stores",
        "192.0.2.1",
        json!({ "project": "willow", "password": password }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    (
        body["store_id"].as_str().unwrap().to_owned(),
        body["kek"].as_str().unwrap().to_owned(),
        body["delete_token"].as_str().unwrap().to_owned(),
    )
}

async fn unlock(
    f: &Fixture,
    id: &str,
    password: &str,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    post(
        f,
        &format!("/api/v1/stores/{id}/unlock"),
        "192.0.2.2",
        json!({ "password": password }),
    )
    .await
}

#[tokio::test]
async fn health() {
    let f = fixture();
    let (status, _, body) = get(&f, "/api/v1/health").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains(r#""status":"ok""#));
}

#[tokio::test]
async fn project_config() {
    let f = fixture();
    let (status, _, body) = get(&f, "/api/v1/p/willow/config").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Willow study"));

    let (status, _, _) = get(&f, "/api/v1/p/missing/config").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _, _) = get(&f, "/api/v1/p/broken/config").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn rejects_path_traversal_in_project_ids() {
    let f = fixture();
    for uri in [
        "/api/v1/p/..%2F..%2Fweb%2Findex/config",
        "/api/v1/p/Willow/config",
        "/api/v1/p/a.b/config",
    ] {
        let (status, _, _) = get(&f, uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
    }
}

#[tokio::test]
async fn unknown_api_routes_are_json_404s() {
    let f = fixture();
    let (status, _, body) = get(&f, "/api/v1/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.contains("not_found"));
}

#[tokio::test]
async fn serves_the_web_client_with_spa_fallback() {
    let f = fixture();
    let (status, headers, body) = get(&f, "/assets/app.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "console.log(1)");
    assert_eq!(headers[header::CONTENT_SECURITY_POLICY], CSP);

    let (status, _, body) = get(&f, "/p/willow").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("<title>Combray</title>"));
}

#[tokio::test]
async fn sets_security_headers_on_api_responses() {
    let f = fixture();
    let (_, headers, _) = get(&f, "/api/v1/health").await;
    assert_eq!(headers[header::CONTENT_SECURITY_POLICY], CSP);
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
}

#[tokio::test]
async fn creates_stores_and_releases_the_kek_only_for_the_right_password() {
    let f = fixture();
    let (id, kek) = create(&f, "madeleine in tea").await;
    assert_eq!(id.len(), 22);
    assert_eq!(kek.len(), 43, "32 bytes, base64url");

    let (status, headers, body) = unlock(&f, &id, "madeleine in tea").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["kek"], kek.as_str());
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");

    let (status, _, body) = unlock(&f, &id, "wrong password").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "wrong_password");
    assert!(body.get("kek").is_none());

    // A second store gets a different KEK.
    let (other, other_kek) = create(&f, "madeleine in tea").await;
    assert_ne!(other, id);
    assert_ne!(other_kek, kek);
}

#[tokio::test]
async fn keks_survive_a_restart_but_not_a_new_master_key() {
    let f = fixture();
    let (id, kek) = create(&f, "madeleine in tea").await;
    let restarted = Fixture {
        app: app(f.config.clone()).unwrap(),
        config: f.config.clone(),
        _dir: tempfile::tempdir().unwrap(),
    };
    assert_eq!(
        unlock(&restarted, &id, "madeleine in tea").await.2["kek"],
        kek.as_str()
    );

    std::fs::write(&f.config.store_master_key_file, [7u8; 32]).unwrap();
    let rekeyed = Fixture {
        app: app(f.config.clone()).unwrap(),
        config: f.config.clone(),
        _dir: tempfile::tempdir().unwrap(),
    };
    assert_ne!(
        unlock(&rekeyed, &id, "madeleine in tea").await.2["kek"],
        kek.as_str()
    );
}

#[tokio::test]
async fn rejects_short_passwords_and_unknown_stores() {
    let f = fixture();
    let (status, _, body) = post(
        &f,
        "/api/v1/stores",
        "192.0.2.1",
        json!({ "project": "willow", "password": "short" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_password");

    let (status, _, body) = unlock(&f, "AAAAAAAAAAAAAAAAAAAAAA", "madeleine in tea").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "no_such_store");
    let (status, _, _) = unlock(&f, "..", "madeleine in tea").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn locks_out_after_repeated_wrong_passwords() {
    let f = fixture();
    let (id, _) = create(&f, "madeleine in tea").await;
    for _ in 0..4 {
        assert_eq!(
            unlock(&f, &id, "a wrong guess").await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let (status, headers, _) = unlock(&f, &id, "a wrong guess").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(headers[header::RETRY_AFTER], "30");
    // Even the right password waits until the lockout ends.
    let (status, headers, body) = unlock(&f, &id, "madeleine in tea").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"], "too_many_attempts");
    assert!(headers.contains_key(header::RETRY_AFTER));
}

#[tokio::test]
async fn rate_limits_new_stores_per_ip() {
    let f = fixture();
    for _ in 0..3 {
        create(&f, "madeleine in tea").await;
    }
    let (status, _, _) = post(
        &f,
        "/api/v1/stores",
        "192.0.2.1",
        json!({ "project": "willow", "password": "madeleine in tea" }),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    // Another IP is not affected.
    let (status, _, _) = post(
        &f,
        "/api/v1/stores",
        "192.0.2.9",
        json!({ "project": "willow", "password": "madeleine in tea" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn deleting_a_store_crypto_shreds_it() {
    let f = fixture();
    let (id, _, token) = create_full(&f, "madeleine in tea").await;
    let uri = format!("/api/v1/stores/{id}/delete");
    for wrong in [
        "",
        "not base64!",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        let (status, _, _) = post(&f, &uri, "192.0.2.3", json!({ "delete_token": wrong })).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{wrong}");
    }
    let (status, _, _) = post(&f, &uri, "192.0.2.3", json!({ "delete_token": token })).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        unlock(&f, &id, "madeleine in tea").await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn the_database_holds_no_keys_or_passwords() {
    let f = fixture();
    let (_, kek) = create(&f, "madeleine in tea").await;
    let db = std::fs::read(&f.config.db_path).unwrap();
    let wal = std::fs::read(f.config.db_path.with_extension("sqlite-wal")).unwrap_or_default();
    for bytes in [db, wal] {
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("madeleine in tea"));
        assert!(!text.contains(&kek));
    }
}

async fn create_in(f: &Fixture, project: &str, participant: Option<&str>) -> (StatusCode, Value) {
    let (status, _, body) = post(
        f,
        "/api/v1/stores",
        "192.0.2.5",
        json!({ "project": project, "participant_id": participant, "password": "madeleine in tea" }),
    )
    .await;
    (status, body)
}

#[tokio::test]
async fn stores_belong_to_projects_that_exist() {
    let f = fixture();
    for project in ["missing", "api", "../oak"] {
        let (status, body) = create_in(&f, project, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{project}");
        assert_eq!(body["error"], "no_such_project");
    }
}

#[tokio::test]
async fn enforces_the_projects_participant_policy() {
    let f = fixture();
    let (status, body) = create_in(&f, "oak", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "participant_required");
    for bad in ["Q1234", "P123", "P1234 ", "P1234\nP"] {
        let (status, body) = create_in(&f, "oak", Some(bad)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(body["error"], "invalid_participant");
    }
    assert_eq!(
        create_in(&f, "oak", Some("P1234")).await.0,
        StatusCode::CREATED
    );
    // Anonymous projects ignore ids; optional ones accept any well-formed id.
    assert_eq!(
        create_in(&f, "elm", Some("P1234")).await.0,
        StatusCode::CREATED
    );
    assert_eq!(
        create_in(&f, "willow", Some("anything-1")).await.0,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn the_served_config_hides_the_participant_pattern() {
    let f = fixture();
    let (status, _, body) = get(&f, "/api/v1/p/oak/config").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("required"));
    assert!(!body.contains("P[0-9]"));
}

async fn reset(f: &Fixture, id: &str, token: &str, password: &str) -> (StatusCode, Value) {
    let (status, _, body) = post(
        f,
        &format!("/api/v1/stores/{id}/reset"),
        "192.0.2.6",
        json!({ "token": token, "password": password }),
    )
    .await;
    (status, body)
}

#[tokio::test]
async fn a_reset_link_sets_a_new_password_and_keeps_the_kek() {
    let f = fixture();
    let (_, body) = create_in(&f, "oak", Some("P1234")).await;
    let id = body["store_id"].as_str().unwrap().to_owned();
    let kek = body["kek"].as_str().unwrap().to_owned();
    let (_, other) = create_in(&f, "oak", Some("P9999")).await;
    let other = other["store_id"].as_str().unwrap().to_owned();
    // Lock the store out first: a reset also lifts the lockout.
    for _ in 0..6 {
        unlock(&f, &id, "forgotten it").await;
    }

    let keys = combray_server::key_service(&f.config).unwrap();
    let token = keys.create_reset_token("oak", "P1234").unwrap();

    // Not for another participant's store, and not with a made-up token.
    assert_eq!(
        reset(&f, &other, &token, "a new password").await.0,
        StatusCode::FORBIDDEN
    );
    let fake = keys.create_reset_token("willow", "P1234").unwrap();
    assert_eq!(
        reset(&f, &id, &fake, "a new password").await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        reset(&f, &id, "nonsense", "a new password").await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        reset(&f, &id, &token, "short").await.0,
        StatusCode::BAD_REQUEST
    );

    let (status, body) = reset(&f, &id, &token, "a new password").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["kek"], kek.as_str());
    assert_eq!(
        unlock(&f, &id, "a new password").await.2["kek"],
        kek.as_str()
    );
    assert_eq!(
        unlock(&f, &id, "madeleine in tea").await.0,
        StatusCode::UNAUTHORIZED
    );
    // Used up.
    assert_eq!(
        reset(&f, &id, &token, "another one!").await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn anonymous_stores_cannot_be_reset() {
    let f = fixture();
    let (_, body) = create_in(&f, "elm", None).await;
    let id = body["store_id"].as_str().unwrap().to_owned();
    let keys = combray_server::key_service(&f.config).unwrap();
    let token = keys.create_reset_token("elm", "P1234").unwrap();
    assert_eq!(
        reset(&f, &id, &token, "a new password").await.0,
        StatusCode::FORBIDDEN
    );
}
