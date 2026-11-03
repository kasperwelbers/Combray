//! HTTP handlers for the store key service (see `keys`): create, unlock, reset and delete a
//! participant's store key. Passwords and keys are never logged.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path as UrlPath, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;

use crate::keys::KeyError;
use crate::projects::{self, ParticipantError};
use crate::{AppState, client_ip, error, no_store, project_error};

#[derive(Deserialize)]
pub struct PasswordBody {
    password: String,
}

#[derive(Deserialize)]
pub struct DeleteBody {
    delete_token: String,
}

#[derive(Deserialize)]
pub struct CreateBody {
    project: String,
    participant_id: Option<String>,
    password: String,
}

#[derive(Deserialize)]
pub struct ResetBody {
    token: String,
    password: String,
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

pub async fn create_store(
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

pub async fn unlock_store(
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

pub async fn reset_store(
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

pub async fn delete_store(
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
