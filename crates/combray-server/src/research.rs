//! The HTTP side of researcher accounts, project keys and donations. See
//! docs/researcher-keys.md for the design and docs/security.md#researcher-sign-in-and-keys for
//! the reasoning behind each check.
//!
//! Two sites, one server:
//!
//! - The **key page** (`COMBRAY_KEYS_URL`, e.g. `https://keys.combray.uni.nl`) is the only place
//!   where researchers sign in with a passkey, and the only one that can fetch key material
//!   (wrapped personal keys, sealed project keys, sealed donation keys). Passkeys are bound to its
//!   host name, so the participant app and the studio on the main site cannot use them at all.
//! - The **main site** (`COMBRAY_PUBLIC_URL`) serves participants and the studio. The studio gets
//!   its own session through a one-time handoff from the key page, and can list projects and
//!   donations, but never fetch a key.
//!
//! Every researcher request must come from the site's own origin (`Origin` and
//! `Sec-Fetch-Site`), so a page on the main site cannot drive the key page's API, even though
//! both are the same site for cookies.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, FromRequestParts, Path as UrlPath, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use url::Url;
use webauthn_rs::prelude::{
    PasskeyAuthentication, PasskeyRegistration, PublicKeyCredential, RegisterPublicKeyCredential,
    Uuid,
};
use webauthn_rs::{Webauthn, WebauthnBuilder};

use crate::accounts::{
    AccountError, Accounts, EMAIL_SESSION_TTL_SECS, KEYS_SESSION_TTL_SECS, LOGIN_CODE_TTL_SECS,
    Level, STUDIO_SESSION_TTL_SECS, Session, Site, b64, normalize_email,
};
use crate::donations::{DonationError, Donations, NewDonation, read_header};
use crate::limits::RateLimit;
use crate::mail::Mailer;
use crate::util::{random_token, valid_random_id};
use crate::{AppState, client_ip, no_store, projects};

/// How long a passkey ceremony may take between its start and finish.
const CEREMONY_TTL: Duration = Duration::from_secs(300);

// Errors.

/// An error answer: a status, a stable code for the client, and maybe a `Retry-After`.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    retry_after: Option<u64>,
}

type ApiResult = Result<Response, ApiError>;

fn fail(status: StatusCode, code: &'static str) -> ApiError {
    ApiError {
        status,
        code,
        retry_after: None,
    }
}

fn internal(class: &'static str) -> ApiError {
    tracing::error!(error_class = class, "researcher service error");
    fail(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

fn too_many(retry_after: u64) -> ApiError {
    ApiError {
        status: StatusCode::TOO_MANY_REQUESTS,
        code: "too_many_attempts",
        retry_after: Some(retry_after),
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = crate::error(self.status, self.code);
        if let Some(secs) = self.retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(secs));
        }
        response
    }
}

impl From<AccountError> for ApiError {
    fn from(e: AccountError) -> Self {
        match e {
            AccountError::NotFound => fail(StatusCode::NOT_FOUND, "not_found"),
            AccountError::Forbidden => fail(StatusCode::FORBIDDEN, "forbidden"),
            AccountError::Conflict => fail(StatusCode::CONFLICT, "conflict"),
            AccountError::Invalid => fail(StatusCode::BAD_REQUEST, "invalid"),
            AccountError::Internal(class) => internal(class),
        }
    }
}

impl From<DonationError> for ApiError {
    fn from(e: DonationError) -> Self {
        match e {
            DonationError::NotFound => fail(StatusCode::NOT_FOUND, "no_such_donation"),
            DonationError::Forbidden => fail(StatusCode::FORBIDDEN, "wrong_token"),
            DonationError::Conflict => fail(StatusCode::CONFLICT, "conflict"),
            DonationError::Internal(class) => internal(class),
        }
    }
}

fn decode_b64(value: &str) -> Result<Vec<u8>, ApiError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "invalid"))
}

// The service.

enum Ceremony {
    Register(PasskeyRegistration),
    Authenticate(PasskeyAuthentication),
}

pub struct Research {
    pub accounts: Accounts,
    pub donations: Donations,
    mailer: Mailer,
    webauthn: Webauthn,
    pub public_url: Url,
    pub keys_url: Url,
    /// Passkey ceremonies in progress, by session.
    ceremonies: Mutex<HashMap<Vec<u8>, (Instant, Ceremony)>>,
    email_per_ip: RateLimit<IpAddr>,
    email_per_address: RateLimit<Vec<u8>>,
    recovery_per_researcher: RateLimit<String>,
    donations_per_ip: RateLimit<IpAddr>,
}

pub struct ResearchOptions {
    pub public_url: Url,
    pub keys_url: Url,
    pub mailer: Mailer,
}

/// `Origin` serialisation of a URL: scheme, host and port.
fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// The `Host` header value a site is reached at.
pub fn host_of(url: &Url) -> String {
    match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_owned(),
    }
}

fn base(url: &Url) -> &str {
    url.as_str().trim_end_matches('/')
}

impl Research {
    pub fn open(
        data_dir: &Path,
        research_db: &Path,
        donation_keys_db: &Path,
        options: ResearchOptions,
    ) -> std::io::Result<Research> {
        let rp_id = options
            .keys_url
            .host_str()
            .ok_or_else(|| std::io::Error::other("COMBRAY_KEYS_URL has no host"))?
            .to_owned();
        let webauthn = WebauthnBuilder::new(&rp_id, &options.keys_url)
            .and_then(|b| b.rp_name("Combray").build())
            .map_err(|e| std::io::Error::other(format!("webauthn: {e:?}")))?;
        Ok(Research {
            accounts: Accounts::open(research_db)?,
            donations: Donations::open(data_dir, donation_keys_db)?,
            mailer: options.mailer,
            webauthn,
            public_url: options.public_url,
            keys_url: options.keys_url,
            ceremonies: Mutex::new(HashMap::new()),
            email_per_ip: RateLimit::new(20, Duration::from_secs(600)),
            email_per_address: RateLimit::new(3, Duration::from_secs(900)),
            recovery_per_researcher: RateLimit::new(5, Duration::from_secs(3600)),
            donations_per_ip: RateLimit::new(60, Duration::from_secs(600)),
        })
    }

    fn site_url(&self, site: Site) -> &Url {
        match site {
            Site::Keys => &self.keys_url,
            Site::Main => &self.public_url,
        }
    }

    fn secure(&self, site: Site) -> bool {
        self.site_url(site).scheme() == "https"
    }

    fn cookie_name(&self, site: Site) -> &'static str {
        // `__Host-` cookies must be Secure, have no Domain and Path=/, so a page on another
        // host of the same site cannot plant or overwrite them.
        if self.secure(site) {
            "__Host-combray"
        } else {
            "combray"
        }
    }

    /// The cookie that ties an emailed sign-in code to the browser that asked for it.
    fn login_cookie_name(&self, site: Site) -> &'static str {
        if self.secure(site) {
            "__Host-combray-login"
        } else {
            "combray-login"
        }
    }

    /// Add a `Set-Cookie` for the pending email sign-in (or, with an empty value, clear it).
    fn with_login_cookie(&self, site: Site, value: &str, mut response: Response) -> Response {
        let max_age = if value.is_empty() {
            0
        } else {
            LOGIN_CODE_TTL_SECS
        };
        let secure = if self.secure(site) { "; Secure" } else { "" };
        let cookie = format!(
            "{}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}",
            self.login_cookie_name(site)
        );
        if let Ok(cookie) = HeaderValue::from_str(&cookie) {
            response.headers_mut().append(header::SET_COOKIE, cookie);
        }
        no_store(response)
    }

    /// A response that sets (or, with an empty value, clears) the session cookie.
    fn with_cookie(&self, site: Site, value: &str, level: Level, response: Response) -> Response {
        let max_age = match (value.is_empty(), site, level) {
            (true, _, _) => 0,
            (_, _, Level::Email) => EMAIL_SESSION_TTL_SECS,
            (_, Site::Keys, Level::Full) => KEYS_SESSION_TTL_SECS,
            (_, Site::Main, Level::Full) => STUDIO_SESSION_TTL_SECS,
        };
        let secure = if self.secure(site) { "; Secure" } else { "" };
        let cookie = format!(
            "{}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}",
            self.cookie_name(site)
        );
        let mut response = no_store(response);
        if let Ok(cookie) = HeaderValue::from_str(&cookie) {
            response.headers_mut().insert(header::SET_COOKIE, cookie);
        }
        response
    }

    /// Refuse requests from other origins. Browsers send `Sec-Fetch-Site` on every request and
    /// `Origin` on every POST, PUT and DELETE; we require the latter for anything that changes
    /// state.
    fn check_origin(
        &self,
        site: Site,
        method: &Method,
        headers: &HeaderMap,
    ) -> Result<(), ApiError> {
        let forbidden = || fail(StatusCode::FORBIDDEN, "cross_origin");
        if let Some(fetch_site) = headers.get("sec-fetch-site")
            && !matches!(fetch_site.to_str(), Ok("same-origin") | Ok("none"))
        {
            return Err(forbidden());
        }
        match headers.get(header::ORIGIN).map(|o| o.to_str()) {
            Some(Ok(origin)) if origin == origin_of(self.site_url(site)) => Ok(()),
            None if method == Method::GET => Ok(()),
            _ => Err(forbidden()),
        }
    }

    fn put_ceremony(&self, session: &Session, ceremony: Ceremony) -> Result<(), ApiError> {
        let mut map = self.ceremonies.lock().map_err(|_| internal("lock"))?;
        let now = Instant::now();
        map.retain(|_, (start, _)| now.duration_since(*start) < CEREMONY_TTL);
        map.insert(session.key.clone(), (now, ceremony));
        Ok(())
    }

    fn take_ceremony(&self, session: &Session) -> Option<Ceremony> {
        let mut map = self.ceremonies.lock().ok()?;
        let (start, ceremony) = map.remove(&session.key)?;
        (start.elapsed() < CEREMONY_TTL).then_some(ceremony)
    }

    /// Complete sign-in: a new session id, so a cookie seen before the second step is worthless.
    fn upgrade(&self, site: Site, session: &Session, response: Response) -> ApiResult {
        if session.level == Level::Full {
            return Ok(no_store(response));
        }
        let token = self.accounts.upgrade_session(session)?;
        Ok(self.with_cookie(site, &token, Level::Full, response))
    }
}

fn research(state: &AppState) -> Result<&Arc<Research>, ApiError> {
    state
        .research
        .as_ref()
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "researchers_disabled"))
}

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

// Extractors. Every researcher handler takes one of these, so none can forget the origin check.

/// A same-origin request to either site, signed in or not.
pub struct Caller {
    r: Arc<Research>,
    site: Site,
}

impl Caller {
    fn keys_only(&self) -> Result<(), ApiError> {
        if self.site != Site::Keys {
            return Err(fail(StatusCode::FORBIDDEN, "key_page_only"));
        }
        Ok(())
    }
}

impl FromRequestParts<AppState> for Caller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let r = research(state)?.clone();
        let site = parts
            .extensions
            .get::<Site>()
            .copied()
            .unwrap_or(Site::Main);
        r.check_origin(site, &parts.method, &parts.headers)?;
        Ok(Caller { r, site })
    }
}

/// A researcher who used the email code; the passkey or recovery code may still be missing.
pub struct Started {
    caller: Caller,
    session: Session,
}

/// A fully signed-in researcher.
pub struct SignedIn {
    caller: Caller,
    session: Session,
}

async fn find_session(parts: &mut Parts, state: &AppState) -> Result<(Caller, Session), ApiError> {
    let caller = Caller::from_request_parts(parts, state).await?;
    let unauthorized = || fail(StatusCode::UNAUTHORIZED, "not_signed_in");
    let token =
        cookie(&parts.headers, caller.r.cookie_name(caller.site)).ok_or_else(unauthorized)?;
    let session = caller
        .r
        .accounts
        .session(token, caller.site)?
        .ok_or_else(unauthorized)?;
    Ok((caller, session))
}

impl FromRequestParts<AppState> for Started {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let (caller, session) = find_session(parts, state).await?;
        Ok(Started { caller, session })
    }
}

impl FromRequestParts<AppState> for SignedIn {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let (caller, session) = find_session(parts, state).await?;
        if session.level != Level::Full {
            return Err(fail(StatusCode::UNAUTHORIZED, "not_signed_in"));
        }
        Ok(SignedIn { caller, session })
    }
}

impl SignedIn {
    fn id(&self) -> &str {
        &self.session.researcher_id
    }

    /// The researcher must be a member of the project; returns whether they have key access.
    fn member_of(&self, project: &str) -> Result<bool, ApiError> {
        let not_found = || fail(StatusCode::NOT_FOUND, "no_such_project");
        if !projects::valid_project_id(project) {
            return Err(not_found());
        }
        self.caller
            .r
            .accounts
            .membership(project, self.id())?
            .ok_or_else(not_found)
    }
}

// Site information.

/// Where the two sites are, so each page can link to the other.
pub async fn site_info(State(state): State<AppState>) -> Response {
    match &state.research {
        Some(r) => Json(json!({
            "researchers": true,
            "public_url": base(&r.public_url),
            "keys_url": base(&r.keys_url),
            // Development servers write mails to a folder; the key page says where to look.
            "mail_outbox": r.mailer.is_outbox(),
        }))
        .into_response(),
        None => Json(json!({ "researchers": false })).into_response(),
    }
}

// Email sign-in.

#[derive(Deserialize)]
pub struct EmailBody {
    email: String,
}

/// Mail a sign-in code, if there is an account for this email. Works on both sites: on the key
/// page it is the first step before the passkey, in the studio it is the whole sign-in. The code
/// only works in this browser, on this site: the answer sets a cookie with a random secret that
/// the code is tied to. The answer is
/// the same either way, and the mail goes out in the background, so the response does not reveal
/// who has an account.
pub async fn request_email_code(
    State(state): State<AppState>,
    caller: Caller,
    headers: HeaderMap,
    peer: Option<axum::Extension<ConnectInfo<SocketAddr>>>,
    Json(body): Json<EmailBody>,
) -> ApiResult {
    let site = caller.site;
    let r = caller.r;
    if !r.mailer.enabled() {
        return Err(fail(StatusCode::SERVICE_UNAVAILABLE, "mail_disabled"));
    }
    r.email_per_ip
        .hit(client_ip(&state.config, &headers, peer))
        .map_err(too_many)?;
    let address =
        normalize_email(&body.email).ok_or(fail(StatusCode::BAD_REQUEST, "invalid_email"))?;
    r.email_per_address
        .hit(Sha256::digest(&address).to_vec())
        .map_err(too_many)?;
    let request = random_token().map_err(|_| internal("random"))?;
    let response = r.with_login_cookie(site, &b64(&request), StatusCode::ACCEPTED.into_response());
    tokio::spawn(async move {
        let Ok(Some(code)) = r.accounts.create_login_code(site, &request, &address) else {
            return;
        };
        let body = format!(
            "Hello,\n\nYour Combray sign-in code is:\n\n    {} {}\n\n\
             Type it on the page where you asked for it. It works for {} minutes, only in that \
             browser.\n\n\
             If you did not ask to sign in, you can ignore this email.\n",
            &code[..4],
            &code[4..],
            LOGIN_CODE_TTL_SECS / 60,
        );
        let _ = r
            .mailer
            .send(&address, "Your Combray sign-in code", body)
            .await;
    });
    Ok(response)
}

#[derive(Deserialize)]
pub struct TokenBody {
    token: String,
}

#[derive(Deserialize)]
pub struct LoginCodeBody {
    code: String,
}

/// Check the emailed code, in the browser that asked for it. On the key page this starts a session
/// that still needs the passkey or recovery code. In the studio it signs in for
/// `STUDIO_SESSION_TTL_SECS`: studio sessions never receive key material.
pub async fn verify_email_code(
    caller: Caller,
    headers: HeaderMap,
    Json(body): Json<LoginCodeBody>,
) -> ApiResult {
    let r = &caller.r;
    let site = caller.site;
    let wrong = || fail(StatusCode::FORBIDDEN, "invalid_code");
    let request = cookie(&headers, r.login_cookie_name(site))
        .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
        .ok_or_else(wrong)?;
    let researcher = r
        .accounts
        .use_login_code(site, &request, &body.code)
        .map_err(|e| match e {
            AccountError::Forbidden | AccountError::Invalid => wrong(),
            e => e.into(),
        })?;
    let level = match site {
        Site::Keys => Level::Email,
        Site::Main => Level::Full,
    };
    let token = r.accounts.create_session(&researcher, site, level)?;
    let me = r.accounts.me(&researcher)?;
    let response = Json(json!({
        "email": me.email,
        "has_passkey": !me.passkeys.is_empty(),
        "has_key": me.public_key.is_some(),
    }))
    .into_response();
    let response = r.with_cookie(site, &token, level, response);
    Ok(r.with_login_cookie(site, "", response))
}

// Passkeys.

pub async fn start_registration(who: Started) -> ApiResult {
    who.caller.keys_only()?;
    let r = &who.caller.r;
    let id = &who.session.researcher_id;
    let existing = r.accounts.passkeys(id)?;
    // With only the email code, a passkey can be added only to an account that has none yet.
    if who.session.level == Level::Email && !existing.is_empty() {
        return Err(fail(StatusCode::FORBIDDEN, "passkey_required"));
    }
    let email = r.accounts.email_of(id)?;
    let user_id = Uuid::parse_str(id).map_err(|_| internal("researcher id"))?;
    let exclude = existing.iter().map(|p| p.cred_id().clone()).collect();
    let (options, state) = r
        .webauthn
        .start_passkey_registration(user_id, &email, &email, Some(exclude))
        .map_err(|_| internal("webauthn"))?;
    r.put_ceremony(&who.session, Ceremony::Register(state))?;
    Ok(no_store(Json(options).into_response()))
}

#[derive(Deserialize)]
pub struct RegisterBody {
    credential: RegisterPublicKeyCredential,
    #[serde(default)]
    name: String,
}

pub async fn finish_registration(who: Started, Json(body): Json<RegisterBody>) -> ApiResult {
    who.caller.keys_only()?;
    let r = &who.caller.r;
    let Some(Ceremony::Register(ceremony)) = r.take_ceremony(&who.session) else {
        return Err(fail(StatusCode::BAD_REQUEST, "no_ceremony"));
    };
    let passkey = r
        .webauthn
        .finish_passkey_registration(&body.credential, &ceremony)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, "passkey_rejected"))?;
    let id = r
        .accounts
        .add_passkey(&who.session.researcher_id, &passkey, &body.name)?;
    r.upgrade(
        who.caller.site,
        &who.session,
        Json(json!({ "credential_id": id })).into_response(),
    )
}

pub async fn start_authentication(who: Started) -> ApiResult {
    who.caller.keys_only()?;
    let r = &who.caller.r;
    let passkeys = r.accounts.passkeys(&who.session.researcher_id)?;
    if passkeys.is_empty() {
        return Err(fail(StatusCode::CONFLICT, "no_passkey"));
    }
    let (options, state) = r
        .webauthn
        .start_passkey_authentication(&passkeys)
        .map_err(|_| internal("webauthn"))?;
    r.put_ceremony(&who.session, Ceremony::Authenticate(state))?;
    Ok(no_store(Json(options).into_response()))
}

#[derive(Deserialize)]
pub struct AuthenticateBody {
    credential: PublicKeyCredential,
}

/// Check the passkey. Returns the personal key wrapped under this passkey, if it holds one: the
/// only way to get it is a fresh passkey assertion.
pub async fn finish_authentication(who: Started, Json(body): Json<AuthenticateBody>) -> ApiResult {
    who.caller.keys_only()?;
    let r = &who.caller.r;
    let id = &who.session.researcher_id;
    let Some(Ceremony::Authenticate(ceremony)) = r.take_ceremony(&who.session) else {
        return Err(fail(StatusCode::BAD_REQUEST, "no_ceremony"));
    };
    let rejected = || fail(StatusCode::UNAUTHORIZED, "passkey_rejected");
    let result = r
        .webauthn
        .finish_passkey_authentication(&body.credential, &ceremony)
        .map_err(|_| rejected())?;
    let mut passkeys = r.accounts.passkeys(id)?;
    let passkey = passkeys
        .iter_mut()
        .find(|p| p.cred_id() == result.cred_id())
        .ok_or_else(rejected)?;
    passkey.update_credential(&result);
    r.accounts.passkey_used(id, passkey)?;
    let credential_id = b64(passkey.cred_id().as_ref());
    let wrapped = r.accounts.wrapped_master(id, &credential_id)?;
    r.upgrade(
        who.caller.site,
        &who.session,
        Json(json!({ "credential_id": credential_id, "wrapped_key": wrapped })).into_response(),
    )
}

#[derive(Deserialize)]
pub struct RecoveryBody {
    secret: String,
}

/// Sign in with the recovery code instead of a passkey (the key page derives the secret from it).
pub async fn recovery_sign_in(who: Started, Json(body): Json<RecoveryBody>) -> ApiResult {
    who.caller.keys_only()?;
    let r = &who.caller.r;
    r.recovery_per_researcher
        .hit(who.session.researcher_id.clone())
        .map_err(too_many)?;
    let secret = decode_b64(&body.secret)?;
    if !r
        .accounts
        .check_recovery(&who.session.researcher_id, &secret)?
    {
        return Err(fail(StatusCode::UNAUTHORIZED, "wrong_recovery_code"));
    }
    r.upgrade(
        who.caller.site,
        &who.session,
        StatusCode::NO_CONTENT.into_response(),
    )
}

pub async fn sign_out(caller: Caller, headers: HeaderMap) -> ApiResult {
    let r = &caller.r;
    if let Some(token) = cookie(&headers, r.cookie_name(caller.site))
        && let Ok(Some(session)) = r.accounts.session(token, caller.site)
    {
        r.accounts.end_session(&session)?;
    }
    Ok(r.with_cookie(
        caller.site,
        "",
        Level::Email,
        StatusCode::NO_CONTENT.into_response(),
    ))
}

/// A one-time code for the studio, so the researcher is signed in there too. The key page
/// sends the browser to `{public_url}/studio/#handoff={code}`.
pub async fn create_handoff(who: SignedIn) -> ApiResult {
    who.caller.keys_only()?;
    let code = who.caller.r.accounts.create_handoff(who.id())?;
    Ok(no_store(Json(json!({ "code": code })).into_response()))
}

#[derive(Deserialize)]
pub struct CodeBody {
    code: String,
}

pub async fn redeem_handoff(caller: Caller, Json(body): Json<CodeBody>) -> ApiResult {
    if caller.site != Site::Main {
        return Err(fail(StatusCode::FORBIDDEN, "studio_only"));
    }
    let r = &caller.r;
    let researcher = r.accounts.use_handoff(&body.code).map_err(|e| match e {
        AccountError::Forbidden | AccountError::Invalid => {
            fail(StatusCode::FORBIDDEN, "invalid_code")
        }
        e => e.into(),
    })?;
    let token = r
        .accounts
        .create_session(&researcher, caller.site, Level::Full)?;
    Ok(r.with_cookie(
        caller.site,
        &token,
        Level::Full,
        StatusCode::NO_CONTENT.into_response(),
    ))
}

// The researcher's own account.

pub async fn me(who: Started) -> ApiResult {
    let me = who.caller.r.accounts.me(&who.session.researcher_id)?;
    Ok(no_store(
        Json(json!({
            "id": me.id,
            "email": me.email,
            "signed_in": who.session.level == Level::Full,
            "public_key": me.public_key,
            "passkeys": me.passkeys,
        }))
        .into_response(),
    ))
}

#[derive(Deserialize)]
pub struct PersonalKeyBody {
    public_key: String,
    recovery_verifier: String,
}

pub async fn set_personal_key(who: SignedIn, Json(body): Json<PersonalKeyBody>) -> ApiResult {
    who.caller.keys_only()?;
    who.caller.r.accounts.set_personal_key(
        who.id(),
        &decode_b64(&body.public_key)?,
        &decode_b64(&body.recovery_verifier)?,
    )?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
pub struct WrappedBody {
    wrapped_key: String,
}

pub async fn set_wrapped_key(
    who: SignedIn,
    UrlPath(credential): UrlPath<String>,
    Json(body): Json<WrappedBody>,
) -> ApiResult {
    who.caller.keys_only()?;
    who.caller.r.accounts.set_wrapped_master(
        who.id(),
        &credential,
        &decode_b64(&body.wrapped_key)?,
    )?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn remove_passkey(who: SignedIn, UrlPath(credential): UrlPath<String>) -> ApiResult {
    who.caller.keys_only()?;
    who.caller
        .r
        .accounts
        .remove_passkey(who.id(), &credential)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// Projects.

async fn project_name(state: &AppState, project: &str) -> serde_json::Value {
    match projects::load(&state.config.data_dir, project).await {
        Ok(p) => p.config.get("name").cloned().unwrap_or(json!(project)),
        Err(_) => json!(project),
    }
}

pub async fn list_projects(State(state): State<AppState>, who: SignedIn) -> ApiResult {
    let accounts = &who.caller.r.accounts;
    let mut out = Vec::new();
    for (id, has_access) in accounts.projects_of(who.id())? {
        let fingerprint = accounts.project_key(&id)?.map(|k| k.fingerprint);
        out.push(json!({
            "id": id,
            "name": project_name(&state, &id).await,
            "has_access": has_access,
            "fingerprint": fingerprint,
        }));
    }
    Ok(no_store(Json(json!({ "projects": out })).into_response()))
}

pub async fn get_project(
    State(state): State<AppState>,
    who: SignedIn,
    UrlPath(project): UrlPath<String>,
) -> ApiResult {
    let has_access = who.member_of(&project)?;
    let accounts = &who.caller.r.accounts;
    // Only the key page receives this member's sealed copy of the project key.
    let sealed = if who.caller.site == Site::Keys && has_access {
        accounts.sealed_project_key(&project, who.id())?
    } else {
        None
    };
    Ok(no_store(
        Json(json!({
            "id": project,
            "name": project_name(&state, &project).await,
            "key": accounts.project_key(&project)?,
            "has_access": has_access,
            "sealed_key": sealed,
            "members": accounts.members(&project)?,
        }))
        .into_response(),
    ))
}

#[derive(Deserialize)]
pub struct SealedBody {
    enc: String,
    ciphertext: String,
}

#[derive(Deserialize)]
pub struct ProjectKeyBody {
    public_key: String,
    fingerprint: String,
    sealed_key: SealedBody,
}

pub async fn create_project_key(
    who: SignedIn,
    UrlPath(project): UrlPath<String>,
    Json(body): Json<ProjectKeyBody>,
) -> ApiResult {
    who.caller.keys_only()?;
    who.member_of(&project)?;
    who.caller.r.accounts.create_project_key(
        &project,
        who.id(),
        &decode_b64(&body.public_key)?,
        &body.fingerprint,
        &decode_b64(&body.sealed_key.enc)?,
        &decode_b64(&body.sealed_key.ciphertext)?,
    )?;
    Ok(StatusCode::CREATED.into_response())
}

/// Add a colleague to the project, creating their account if needed. They get access to the key
/// only once a member with access grants it from the key page.
pub async fn add_member(
    who: SignedIn,
    UrlPath(project): UrlPath<String>,
    Json(body): Json<EmailBody>,
) -> ApiResult {
    who.caller.keys_only()?;
    who.member_of(&project)?;
    let r = who.caller.r.clone();
    let email =
        normalize_email(&body.email).ok_or(fail(StatusCode::BAD_REQUEST, "invalid_email"))?;
    let id = r.accounts.add_researcher(&email)?;
    r.accounts.add_member(&project, &id)?;
    let inviter = r.accounts.email_of(who.id())?;
    tokio::spawn(async move {
        let body = format!(
            "Hello,\n\n{inviter} added you to the project \"{project}\" on Combray.\n\n\
             Sign in at {} with this email address to set up your passkey and key. Then ask \
             {inviter} to give you access; you will compare a short code with each other.\n",
            base(&r.keys_url)
        );
        let _ = r
            .mailer
            .send(&email, "You were added to a Combray project", body)
            .await;
    });
    Ok(StatusCode::CREATED.into_response())
}

pub async fn grant_access(
    who: SignedIn,
    UrlPath((project, researcher)): UrlPath<(String, String)>,
    Json(body): Json<SealedBody>,
) -> ApiResult {
    who.caller.keys_only()?;
    who.member_of(&project)?;
    who.caller.r.accounts.grant(
        &project,
        who.id(),
        &researcher,
        &decode_b64(&body.enc)?,
        &decode_b64(&body.ciphertext)?,
    )?;
    tracing::info!(
        event = "project_key_granted",
        "a member granted project key access"
    );
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn remove_member(
    who: SignedIn,
    UrlPath((project, researcher)): UrlPath<(String, String)>,
) -> ApiResult {
    who.caller.keys_only()?;
    who.member_of(&project)?;
    who.caller.r.accounts.remove_member(&project, &researcher)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// Donations, researcher side.

pub async fn list_donations(who: SignedIn, UrlPath(project): UrlPath<String>) -> ApiResult {
    who.member_of(&project)?;
    let (donations, withdrawn) = who.caller.r.donations.list(&project)?;
    Ok(no_store(
        Json(json!({ "donations": donations, "withdrawn": withdrawn })).into_response(),
    ))
}

pub async fn get_envelope(
    who: SignedIn,
    UrlPath((project, donation)): UrlPath<(String, String)>,
) -> ApiResult {
    who.caller.keys_only()?;
    who.member_of(&project)?;
    let bytes = who.caller.r.donations.envelope(&project, &donation)?;
    Ok(no_store(
        ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response(),
    ))
}

#[derive(Deserialize)]
pub struct IdsBody {
    ids: Vec<String>,
}

/// The sealed keys of some donations, for a member with access, on the key page only. Fetched on
/// every use and never stored by the key page.
pub async fn donation_keys(
    who: SignedIn,
    UrlPath(project): UrlPath<String>,
    Json(body): Json<IdsBody>,
) -> ApiResult {
    who.caller.keys_only()?;
    if !who.member_of(&project)? {
        return Err(fail(StatusCode::FORBIDDEN, "no_key_access"));
    }
    if body.ids.len() > 1000 {
        return Err(fail(StatusCode::BAD_REQUEST, "too_many_ids"));
    }
    let keys = who.caller.r.donations.sealed_keys(&project, &body.ids)?;
    tracing::info!(
        event = "donation_keys_fetched",
        count = keys.len(),
        "sealed keys fetched"
    );
    Ok(no_store(Json(json!({ "keys": keys })).into_response()))
}

pub async fn withdraw_for_participant(
    who: SignedIn,
    UrlPath((project, donation)): UrlPath<(String, String)>,
) -> ApiResult {
    who.caller.keys_only()?;
    who.member_of(&project)?;
    who.caller
        .r
        .donations
        .withdraw_for_project(&project, &donation)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// Donations, participant side.

/// Accept a donation. The body is `u32 length (big-endian) | sealed key JSON | envelope`. The
/// server checks the envelope header against the project and its key; the header is
/// authenticated by the sealed key, so a client that lies here only makes a donation that does
/// not open.
pub async fn donate(
    State(state): State<AppState>,
    caller: Caller,
    UrlPath(project): UrlPath<String>,
    headers: HeaderMap,
    peer: Option<axum::Extension<ConnectInfo<SocketAddr>>>,
    body: Bytes,
) -> ApiResult {
    let r = &caller.r;
    r.donations_per_ip
        .hit(client_ip(&state.config, &headers, peer))
        .map_err(too_many)?;
    if projects::load(&state.config.data_dir, &project)
        .await
        .is_err()
    {
        return Err(fail(StatusCode::NOT_FOUND, "no_such_project"));
    }
    let key = r
        .accounts
        .project_key(&project)?
        .ok_or(fail(StatusCode::CONFLICT, "no_project_key"))?;
    let invalid = || fail(StatusCode::BAD_REQUEST, "invalid_donation");
    let length = body
        .get(..4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
        .filter(|&n| n <= 8 * 1024 && 4 + n <= body.len())
        .ok_or_else(invalid)?;
    let sealed: SealedBody = serde_json::from_slice(&body[4..4 + length]).map_err(|_| invalid())?;
    let envelope = &body[4 + length..];
    let h = read_header(envelope).ok_or_else(invalid)?;
    if h.v != 1 || h.project != project || !valid_random_id(&h.donation) || h.key != key.fingerprint
    {
        return Err(invalid());
    }
    let (enc, ct) = (decode_b64(&sealed.enc)?, decode_b64(&sealed.ciphertext)?);
    if enc.len() > 2048 || ct.len() > 256 {
        return Err(invalid());
    }
    let token = r.donations.store(NewDonation {
        project: &project,
        id: &h.donation,
        key_fingerprint: &key.fingerprint,
        enc: &enc,
        ciphertext: &ct,
        envelope,
    })?;
    Ok(no_store(
        (
            StatusCode::CREATED,
            Json(json!({ "donation": h.donation, "withdrawal_token": token })),
        )
            .into_response(),
    ))
}

pub async fn withdraw(
    State(state): State<AppState>,
    caller: Caller,
    UrlPath(donation): UrlPath<String>,
    headers: HeaderMap,
    peer: Option<axum::Extension<ConnectInfo<SocketAddr>>>,
    Json(body): Json<TokenBody>,
) -> ApiResult {
    let r = &caller.r;
    r.donations_per_ip
        .hit(client_ip(&state.config, &headers, peer))
        .map_err(too_many)?;
    let token = decode_b64(&body.token).map_err(|_| fail(StatusCode::FORBIDDEN, "wrong_token"))?;
    r.donations.withdraw_with_token(&donation, &token)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
