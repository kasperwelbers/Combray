//! The Combray server, Phase 1 scope: serve the web client, a health check and read-only project
//! configs from the data directory. Store keys, enrichment and donations come in later phases.
//!
//! Privacy rule: logs contain the method, the route template, the status and the duration. Never
//! the URL, query string, headers or bodies.

use std::path::{Path, PathBuf};
use std::time::Instant;

use axum::extract::{MatchedPath, Path as UrlPath, Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Content Security Policy for the web client: no inline scripts, no third-party origins.
/// `wasm-unsafe-eval` allows compiling WebAssembly (the importer script sandbox), not JS `eval`.
/// See docs/privacy-and-encryption.md#code-integrity.
pub const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
    img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; \
    object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

#[derive(Clone, Debug)]
pub struct Config {
    /// Directory with the built web client (`apps/web/dist`).
    pub web_dir: PathBuf,
    /// The server's data directory; project configs live in `projects/{id}.json`.
    pub data_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Config {
        let var = |name: &str, default: &str| {
            PathBuf::from(std::env::var(name).unwrap_or_else(|_| default.to_string()))
        };
        Config {
            web_dir: var("COMBRAY_WEB_DIR", "apps/web/dist"),
            data_dir: var("COMBRAY_DATA_DIR", "combray-data"),
        }
    }
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "version": VERSION }))
}

fn valid_project_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Serve a project's config. In Phase 2 these are signed and registered from the researcher
/// tool; for now they are JSON files placed in the data directory by the operator.
async fn project_config(State(config): State<Config>, UrlPath(id): UrlPath<String>) -> Response {
    if !valid_project_id(&id) {
        return error(StatusCode::NOT_FOUND, "not_found");
    }
    let path = config.data_dir.join("projects").join(format!("{id}.json"));
    match tokio::fs::read(&path).await {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) => Json(value).into_response(),
            Err(_) => {
                tracing::error!(
                    error_class = "invalid_project_config",
                    "project config is not valid JSON"
                );
                error(StatusCode::INTERNAL_SERVER_ERROR, "invalid_config")
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            error(StatusCode::NOT_FOUND, "not_found")
        }
        Err(_) => {
            tracing::error!(error_class = "io", "could not read project config");
            error(StatusCode::INTERNAL_SERVER_ERROR, "io")
        }
    }
}

/// Log requests by route template only, never by URL.
async fn log_requests(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_else(|| "static".to_owned());
    let start = Instant::now();
    let response = next.run(request).await;
    tracing::info!(
        %method,
        route,
        status = response.status().as_u16(),
        duration_ms = start.elapsed().as_millis() as u64,
        "request"
    );
    response
}

fn static_files(web_dir: &Path) -> ServeDir<ServeFile> {
    // Unknown paths get index.html so client-side routes work.
    ServeDir::new(web_dir).fallback(ServeFile::new(web_dir.join("index.html")))
}

pub fn app(config: Config) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/p/{id}/config", get(project_config))
        .fallback(|| async { error(StatusCode::NOT_FOUND, "not_found") })
        .with_state(config.clone());

    let headers = [
        (header::CONTENT_SECURITY_POLICY, CSP),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::X_FRAME_OPTIONS, "DENY"),
        (
            HeaderName::from_static("permissions-policy"),
            "camera=(), microphone=(), geolocation=(), interest-cohort=()",
        ),
        (
            HeaderName::from_static("cross-origin-opener-policy"),
            "same-origin",
        ),
    ];

    let mut router = Router::new()
        .nest("/api/v1", api)
        .fallback_service(static_files(&config.web_dir))
        .layer(middleware::from_fn(log_requests));
    for (name, value) in headers {
        router = router.layer(SetResponseHeaderLayer::if_not_present(
            name,
            HeaderValue::from_static(value),
        ));
    }
    router
}
