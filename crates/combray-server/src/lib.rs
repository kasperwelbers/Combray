//! The Combray server: serves the web client, a health check, read-only project configs from the
//! data directory, the store key service (`keys`, `stores`), and, when a key page URL is set,
//! researcher sign-in, project keys and donations (`research`). Enrichment comes later.
//!
//! The server answers on two host names. The main site (`COMBRAY_PUBLIC_URL`) serves the
//! participant app and the studio. The key page (`COMBRAY_KEYS_URL`) serves one small page,
//! the only place where researchers use passkeys and handle keys (docs/researcher-keys.md).
//!
//! Privacy rule: logs contain the method, the route template, the status and the duration. Never
//! the URL, query string, headers or bodies.

pub mod accounts;
pub mod donations;
pub mod keys;
pub mod limits;
pub mod mail;
pub mod projects;
pub mod research;
pub mod stores;
pub mod util;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{ConnectInfo, DefaultBodyLimit, MatchedPath, Path as UrlPath, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use serde_json::json;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use url::Url;

use accounts::Site;
use keys::{Argon2Cost, KeyService, RateLimits};
use mail::{MailConfig, Mailer};
use projects::LoadError;
use research::{Research, ResearchOptions};

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

/// The main site may never use passkeys: they are bound to the key page's host name anyway,
/// and this keeps even a script injected into the participant app from starting a ceremony.
const MAIN_PERMISSIONS: &str = "camera=(), microphone=(), geolocation=(), interest-cohort=(), \
    publickey-credentials-get=(), publickey-credentials-create=()";
const KEYS_PERMISSIONS: &str = "camera=(), microphone=(), geolocation=(), interest-cohort=(), \
    publickey-credentials-get=(self), publickey-credentials-create=(self)";

/// Researcher sign-in and donations, enabled by setting both site URLs.
#[derive(Clone, Debug)]
pub struct ResearchConfig {
    /// The main site, e.g. `https://combray.uni.nl` (`COMBRAY_PUBLIC_URL`).
    pub public_url: Url,
    /// The key page, e.g. `https://keys.combray.uni.nl` (`COMBRAY_KEYS_URL`). Passkeys are bound
    /// to its host name.
    pub keys_url: Url,
    /// The built key page (`apps/keys/dist/index.html`).
    pub keys_page: PathBuf,
    /// Researcher accounts, passkeys, project members and project keys.
    pub research_db: PathBuf,
    /// Sealed donation keys. Keep it on its own volume, with short backup retention
    /// (docs/key-design.md#6-withdrawing).
    pub donation_keys_db: PathBuf,
    pub mail: MailConfig,
    pub max_donation_bytes: usize,
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Directory with the built web client (`apps/web/dist`).
    pub web_dir: PathBuf,
    /// The server's data directory; project configs live in `projects/{id}.json`, donation
    /// envelopes in `donations/`.
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
    pub research: Option<ResearchConfig>,
}

fn env_url(name: &str) -> Option<Url> {
    let value = std::env::var(name).ok()?;
    match Url::parse(&value) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => {
            Some(url)
        }
        _ => {
            tracing::error!(variable = name, "not a valid http(s) URL");
            None
        }
    }
}

impl Config {
    pub fn from_env() -> Config {
        let var = |name: &str, default: &Path| {
            std::env::var(name)
                .map(PathBuf::from)
                .unwrap_or_else(|_| default.to_path_buf())
        };
        let data_dir = var("COMBRAY_DATA_DIR", Path::new("combray-data"));
        let research = match (env_url("COMBRAY_PUBLIC_URL"), env_url("COMBRAY_KEYS_URL")) {
            (Some(public_url), Some(keys_url)) => Some(ResearchConfig {
                public_url,
                keys_url,
                keys_page: var("COMBRAY_KEYS_PAGE", Path::new("apps/keys/dist/index.html")),
                research_db: var("COMBRAY_RESEARCH_DB", &data_dir.join("research.sqlite")),
                donation_keys_db: var(
                    "COMBRAY_DONATION_KEYS_DB",
                    &data_dir.join("donation-keys.sqlite"),
                ),
                mail: MailConfig::from_env(),
                max_donation_bytes: std::env::var("COMBRAY_MAX_DONATION_MB")
                    .ok()
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(64)
                    * 1024
                    * 1024,
            }),
            _ => None,
        };
        Config {
            web_dir: var("COMBRAY_WEB_DIR", Path::new("apps/web/dist")),
            db_path: var("COMBRAY_DB", &data_dir.join("combray.sqlite")),
            data_dir,
            store_master_key_file: var(
                "COMBRAY_STORE_MASTER_KEY_FILE",
                Path::new("combray-store-master.key"),
            ),
            client_ip_header: std::env::var("COMBRAY_CLIENT_IP_HEADER")
                .ok()
                .and_then(|h| HeaderName::try_from(h.to_ascii_lowercase()).ok()),
            argon2: Argon2Cost::default(),
            rate_limits: RateLimits::default(),
            research,
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    config: Config,
    keys: Arc<KeyService>,
    research: Option<Arc<Research>>,
}

pub(crate) fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "version": VERSION }))
}

pub(crate) fn project_error(e: LoadError) -> Response {
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

/// Serve a project's config, with the project's public key once a researcher has created it.
/// The participant id pattern is left out: the client does not need it, and there is no reason
/// to show which ids are valid.
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
            if let (Some(r), Some(obj)) = (&state.research, config.as_object_mut()) {
                match r.accounts.project_key(&id) {
                    Ok(Some(key)) => {
                        obj.insert(
                            "donation_key".into(),
                            json!({ "public_key": key.public_key, "fingerprint": key.fingerprint }),
                        );
                    }
                    Ok(None) => {}
                    Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
                }
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

/// The client IP, for rate limiting only. Never stored or logged.
pub(crate) fn client_ip(
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

/// Key material must never be cached by the browser or a proxy.
pub(crate) fn no_store(response: Response) -> Response {
    let mut response = response;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Open the store key service described by the config.
pub fn key_service(config: &Config) -> std::io::Result<KeyService> {
    let master = keys::load_store_master_key(&config.store_master_key_file)?;
    KeyService::open(&config.db_path, master, config.argon2, config.rate_limits)
}

/// Open researcher accounts and donation storage, if enabled.
pub fn research_service(config: &Config) -> std::io::Result<Option<Research>> {
    let Some(rc) = &config.research else {
        return Ok(None);
    };
    let mailer = Mailer::new(&rc.mail);
    if !mailer.enabled() {
        tracing::warn!("no mail settings: researchers cannot sign in (see docs/deployment.md)");
    }
    Research::open(
        &config.data_dir,
        &rc.research_db,
        &rc.donation_keys_db,
        ResearchOptions {
            public_url: rc.public_url.clone(),
            keys_url: rc.keys_url.clone(),
            mailer,
        },
    )
    .map(Some)
}

/// The key page: one self-contained HTML file. Its Content Security Policy is in a `<meta>` tag
/// (so the downloadable copy carries it too); the server sends the same policy as a header and
/// adds what a `<meta>` tag cannot express.
struct KeysPage {
    html: Option<axum::body::Bytes>,
    csp: String,
}

impl KeysPage {
    fn load(path: &Path) -> KeysPage {
        let Ok(html) = std::fs::read_to_string(path) else {
            tracing::error!("the key page is not built (pnpm --filter @combray/keys build)");
            return KeysPage {
                html: None,
                csp: String::new(),
            };
        };
        let csp = html
            .split("http-equiv=\"Content-Security-Policy\" content=\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or("default-src 'none'")
            .to_owned();
        KeysPage {
            csp: format!("{csp}; frame-ancestors 'none'"),
            html: Some(html.into()),
        }
    }

    fn response(&self) -> Response {
        let Some(html) = &self.html else {
            return error(StatusCode::SERVICE_UNAVAILABLE, "key_page_not_built");
        };
        let mut response = (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            html.clone(),
        )
            .into_response();
        if let Ok(csp) = HeaderValue::from_str(&self.csp) {
            response
                .headers_mut()
                .insert(header::CONTENT_SECURITY_POLICY, csp);
        }
        response
    }
}

fn security_headers(
    mut router: Router,
    permissions: &'static str,
    csp: Option<&'static str>,
) -> Router {
    let mut headers = vec![
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::X_FRAME_OPTIONS, "DENY"),
        (HeaderName::from_static("permissions-policy"), permissions),
        (
            HeaderName::from_static("cross-origin-opener-policy"),
            "same-origin",
        ),
    ];
    if let Some(csp) = csp {
        headers.push((header::CONTENT_SECURITY_POLICY, csp));
    }
    for (name, value) in headers {
        router = router.layer(SetResponseHeaderLayer::if_not_present(
            name,
            HeaderValue::from_static(value),
        ));
    }
    router
}

/// Build the app. Fails if a database or the store master key cannot be opened.
pub fn app(config: Config) -> std::io::Result<Router> {
    let state = AppState {
        keys: Arc::new(key_service(&config)?),
        research: research_service(&config)?.map(Arc::new),
        config: config.clone(),
    };

    let stores = Router::new()
        .route("/stores", post(stores::create_store))
        .route("/stores/{id}/unlock", post(stores::unlock_store))
        .route("/stores/{id}/reset", post(stores::reset_store))
        .route("/stores/{id}/delete", post(stores::delete_store))
        .layer(DefaultBodyLimit::max(8 * 1024));
    let max_donation = config
        .research
        .as_ref()
        .map_or(0, |r| r.max_donation_bytes + 16 * 1024);
    let main_research = Router::new()
        .route("/auth/handoff/redeem", post(research::redeem_handoff))
        .route("/auth/logout", post(research::sign_out))
        .route("/me", get(research::me))
        .route("/projects", get(research::list_projects))
        .route("/projects/{id}", get(research::get_project))
        .route("/projects/{id}/donations", get(research::list_donations))
        .route("/donations/{id}/withdraw", post(research::withdraw))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .route(
            "/p/{id}/donations",
            post(research::donate).layer(DefaultBodyLimit::max(max_donation)),
        );
    let main_api = Router::new()
        .route("/health", get(health))
        .route("/site", get(research::site_info))
        .route("/p/{id}/config", get(project_config))
        .merge(stores)
        .merge(main_research)
        .fallback(|| async { error(StatusCode::NOT_FOUND, "not_found") })
        .with_state(state.clone());
    let main = Router::new()
        .nest("/api/v1", main_api)
        .fallback_service(static_files(&config.web_dir))
        .layer(middleware::from_fn(log_requests))
        .layer(Extension(Site::Main));
    let main = security_headers(main, MAIN_PERMISSIONS, Some(CSP));

    let Some(research) = &state.research else {
        return Ok(main);
    };
    let keys_api = Router::new()
        .route("/health", get(health))
        .route("/site", get(research::site_info))
        .route("/auth/email", post(research::request_email_link))
        .route("/auth/email/verify", post(research::verify_email_link))
        .route(
            "/auth/passkey/register/start",
            post(research::start_registration),
        )
        .route(
            "/auth/passkey/register/finish",
            post(research::finish_registration),
        )
        .route("/auth/passkey/start", post(research::start_authentication))
        .route(
            "/auth/passkey/finish",
            post(research::finish_authentication),
        )
        .route("/auth/recovery", post(research::recovery_sign_in))
        .route("/auth/logout", post(research::sign_out))
        .route("/auth/handoff", post(research::create_handoff))
        .route("/me", get(research::me))
        .route("/me/key", post(research::set_personal_key))
        .route("/me/passkeys/{id}", delete(research::remove_passkey))
        .route("/me/passkeys/{id}/wrapped", put(research::set_wrapped_key))
        .route("/projects", get(research::list_projects))
        .route("/projects/{id}", get(research::get_project))
        .route("/projects/{id}/key", post(research::create_project_key))
        .route("/projects/{id}/members", post(research::add_member))
        .route(
            "/projects/{id}/members/{researcher}",
            delete(research::remove_member),
        )
        .route(
            "/projects/{id}/members/{researcher}/key",
            put(research::grant_access),
        )
        .route("/projects/{id}/donations", get(research::list_donations))
        .route(
            "/projects/{id}/donations/{donation}",
            get(research::get_envelope).delete(research::withdraw_for_participant),
        )
        .route(
            "/projects/{id}/donation-keys",
            post(research::donation_keys),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .fallback(|| async { error(StatusCode::NOT_FOUND, "not_found") })
        .with_state(state.clone());
    let page = Arc::new(KeysPage::load(
        &config
            .research
            .as_ref()
            .map(|r| r.keys_page.clone())
            .unwrap_or_default(),
    ));
    let keys = Router::new()
        .nest("/api/v1", keys_api)
        .route("/", get(move || async move { page.response() }))
        .fallback(|| async { error(StatusCode::NOT_FOUND, "not_found") })
        .layer(middleware::from_fn(log_requests))
        .layer(Extension(Site::Keys));
    let keys = security_headers(keys, KEYS_PERMISSIONS, None).layer(
        SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("same-origin"),
        ),
    );

    // One server, two host names: requests for the key page's host go to the key page router.
    let keys_host = research::host_of(&research.keys_url).to_ascii_lowercase();
    Ok(Router::new().fallback(move |request: Request| {
        let host = request
            .headers()
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned)
            .or_else(|| request.uri().authority().map(|a| a.to_string()))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let router = if host == keys_host {
            keys.clone()
        } else {
            main.clone()
        };
        async move {
            match router.oneshot(request).await {
                Ok(response) => response,
                Err(never) => match never {},
            }
        }
    }))
}
