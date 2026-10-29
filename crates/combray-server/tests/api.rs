use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use combray_server::{CSP, Config, app};
use http_body_util::BodyExt;
use tower::ServiceExt;

struct Fixture {
    _dir: tempfile::TempDir,
    config: Config,
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
    std::fs::write(data.join("projects/broken.json"), "{not json").unwrap();
    Fixture {
        config: Config {
            web_dir: web,
            data_dir: data,
        },
        _dir: dir,
    }
}

async fn get(f: &Fixture, uri: &str) -> (StatusCode, axum::http::HeaderMap, String) {
    let response = app(f.config.clone())
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8_lossy(&body).into_owned())
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
