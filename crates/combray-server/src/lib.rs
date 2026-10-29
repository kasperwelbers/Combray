//! The Combray server: serves the web client, a health check, read-only project configs from the
//! data directory, and the store key service (see `keys`). Enrichment and donations come later.
//!
//! Privacy rule: logs contain the method, the route template, the status and the duration. Never
//! the URL, query string, headers or bodies.

pub mod keys;
pub mod projects;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{ConnectInfo, DefaultBodyLimit, MatchedPath, Path as UrlPath, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use keys::{Argon2Cost, KeyError, KeyService, RateLimits};
use projects::{LoadError, ParticipantError};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Content Security Policy for the web client: no inline scripts, no third-party origins.
/// `wasm-unsafe-eval` allows compiling WebAssembly (the importer script sandbox), not JS `eval`.
/// Trusted Types make DOM sinks such as `innerHTML` refuse plain strings; the client defines only
/// a `default` policy that allows same-origin script URLs and rejects HTML and scripts.
/// See docs/security.md#xss-and-code-integrity.
pub const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
    img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; \
    object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; \
    require-trusted-types-for 'script'; trusted-types default";

#[derive(Clone, Debug)]
pub struct Config {
    /// Directory with the built web client (`apps/web/dist`).
    pub web_dir: PathBuf,
    /// The server's data directory; project configs live in `projects/{id}.json`.
    pub data_dir: PathBuf,
    /// The SQLite database with store key records.
    pub db_path: PathBuf,
    /// 32 random bytes from which every store's KEK is derived. Keep it outside the data
    /// directory, so a backup of the data alone holds no usable keys. Created if missing.
    pub store_master_key_file: PathBuf,
    /// Header with the client IP when behind a reverse proxy (e.g. `x-forwarded-for`, whose last
    /// entry is used). Without it the peer address is used.
    pub client_ip_header: Option<HeaderName>,
    pub argon2: Argon2Cost,
    pub rate_limits: RateLimits,
}

impl Config {
    pub fn from_env() -> Config {
        let var = |name: &str, default: &str| {
            PathBuf::from(std::env::var(name).unwrap_or_else(|_| default.to_string()))
        };
        let data_dir = var("COMBRAY_DATA_DIR", "combray-data");
        Config {
            web_dir: var("COMBRAY_WEB_DIR", "apps/web/dist"),
            db_path: std::env::var("COMBRAY_DB")
                .map(PathBuf::from)
                .unwrap_or_else(|_| data_dir.join("combray.sqlite")),
            data_dir,
            store_master_key_file: var("COMBRAY_STORE_MASTER_KEY_FILE", "combray-store-master.key"),
            client_ip_header: std::env::var("COMBRAY_CLIENT_IP_HEADER")
                .ok()
                .and_then(|h| HeaderName::try_from(h.to_ascii_lowercase()).ok()),
            argon2: Argon2Cost::default(),
            rate_limits: RateLimits::default(),
        }
    }
}

#[derive(Clone)]
struct AppState {
    config: Config,
    keys: Arc<KeyService>,
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "version": VERSION }))
}

fn project_error(e: LoadError) -> Response {
    match e {
        LoadError::NotFound => error(StatusCode::NOT_FOUND, "no_such_project"),
        LoadError::Invalid => {
            tracing::error!(
                error_class = "invalid_project_config",
                "project config is invalid"
            );
            error(StatusCode::INTERNAL_SERVER_ERROR, "invalid_config")
        }
        LoadError::Io => {
            tracing::error!(error_class = "io", "could not read project config");
            error(StatusCode::INTERNAL_SERVER_ERROR, "io")
        }
    }
}

/// Serve a project's config. The participant id pattern is left out: the client does not need
/// it, and there is no reason to show which ids are valid.
async fn project_config(State(state): State<AppState>, UrlPath(id): UrlPath<String>) -> Response {
    match projects::load(&state.config.data_dir, &id).await {
        Ok(project) => {
            let mut config = project.config;
            if let Some(p) = config
                .get_mut("participants")
                .and_then(|p| p.as_object_mut())
            {
                p.remove("pattern");
            }
            Json(config).into_response()
        }
        Err(e) => project_error(e),
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

#[derive(Deserialize)]
struct PasswordBody {
    password: String,
}

#[derive(Deserialize)]
struct DeleteBody {
    delete_token: String,
}

#[derive(Deserialize)]
struct CreateBody {
    project: String,
    participant_id: Option<String>,
    password: String,
}

#[derive(Deserialize)]
struct ResetBody {
    token: String,
    password: String,
}

/// The client IP, for rate limiting only. Never stored or logged.
fn client_ip(
    config: &Config,
    headers: &HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> IpAddr {
    if let Some(name) = &config.client_ip_header {
        return headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    }
    peer.map_or(
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        |Extension(ConnectInfo(a))| a.ip(),
    )
}

fn key_error(e: KeyError) -> Response {
    let retry = |mut response: Response, secs: Option<u64>| {
        if let Some(secs) = secs {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(secs));
        }
        response
    };
    match e {
        KeyError::InvalidPassword => error(StatusCode::BAD_REQUEST, "invalid_password"),
        KeyError::NotFound => error(StatusCode::NOT_FOUND, "no_such_store"),
        KeyError::InvalidResetToken => error(StatusCode::FORBIDDEN, "invalid_reset_token"),
        KeyError::WrongPassword { retry_after } => retry(
            error(StatusCode::UNAUTHORIZED, "wrong_password"),
            retry_after,
        ),
        KeyError::TooManyAttempts { retry_after } => retry(
            error(StatusCode::TOO_MANY_REQUESTS, "too_many_attempts"),
            Some(retry_after),
        ),
        KeyError::Internal(class) => {
            tracing::error!(error_class = class, "store key service error");
            error(StatusCode::INTERNAL_SERVER_ERROR, "internal")
        }
    }
}

/// Key material must never be cached by the browser or a proxy.
fn no_store(response: Response) -> Response {
    let mut response = response;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn create_store(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Json(body): Json<CreateBody>,
) -> Response {
    let ip = client_ip(&state.config, &headers, peer);
    let project = match projects::load(&state.config.data_dir, &body.project).await {
        Ok(project) => project,
        Err(e) => return project_error(e),
    };
    let participant = match project.check_participant(body.participant_id.as_deref()) {
        Ok(participant) => participant,
        Err(ParticipantError::Required) => {
            return error(StatusCode::BAD_REQUEST, "participant_required");
        }
        Err(ParticipantError::Invalid) => {
            return error(StatusCode::BAD_REQUEST, "invalid_participant");
        }
    };
    let created = state
        .keys
        .create(ip, &body.project, participant, &body.password)
        .await;
    no_store(match created {
        Ok(store) => (
            StatusCode::CREATED,
            Json(json!({
                "store_id": store.store_id,
                "kek": store.kek,
                "delete_token": store.delete_token,
            })),
        )
            .into_response(),
        Err(e) => key_error(e),
    })
}

async fn unlock_store(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Json(body): Json<PasswordBody>,
) -> Response {
    let ip = client_ip(&state.config, &headers, peer);
    no_store(match state.keys.unlock(ip, &id, &body.password).await {
        Ok(kek) => Json(json!({ "kek": kek })).into_response(),
        Err(e) => key_error(e),
    })
}

async fn reset_store(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Json(body): Json<ResetBody>,
) -> Response {
    let ip = client_ip(&state.config, &headers, peer);
    no_store(
        match state.keys.reset(ip, &id, &body.token, &body.password).await {
            Ok(kek) => Json(json!({ "kek": kek })).into_response(),
            Err(e) => key_error(e),
        },
    )
}

async fn delete_store(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Json(body): Json<DeleteBody>,
) -> Response {
    let ip = client_ip(&state.config, &headers, peer);
    match state.keys.delete(ip, &id, &body.delete_token).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => key_error(e),
    }
}

/// Open the store key service described by the config.
pub fn key_service(config: &Config) -> std::io::Result<KeyService> {
    let master = keys::load_store_master_key(&config.store_master_key_file)?;
    KeyService::open(&config.db_path, master, config.argon2, config.rate_limits)
}

/// Build the app. Fails if the key database or the store master key cannot be opened.
pub fn app(config: Config) -> std::io::Result<Router> {
    let keys = Arc::new(key_service(&config)?);
    let state = AppState {
        config: config.clone(),
        keys,
    };
    let stores = Router::new()
        .route("/stores", post(create_store))
        .route("/stores/{id}/unlock", post(unlock_store))
        .route("/stores/{id}/reset", post(reset_store))
        .route("/stores/{id}/delete", post(delete_store))
        .layer(DefaultBodyLimit::max(8 * 1024));
    let api = Router::new()
        .route("/health", get(health))
        .route("/p/{id}/config", get(project_config))
        .merge(stores)
        .fallback(|| async { error(StatusCode::NOT_FOUND, "not_found") })
        .with_state(state);

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
    Ok(router)
}
