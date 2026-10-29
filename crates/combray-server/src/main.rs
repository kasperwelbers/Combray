use std::net::SocketAddr;

use combray_server::projects::{valid_participant_id, valid_project_id};
use combray_server::{Config, VERSION, app, key_service};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config = Config::from_env();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [command, project, participant] = args.as_slice()
        && command == "reset-link"
    {
        return reset_link(&config, project, participant);
    }
    if !args.is_empty() {
        eprintln!("usage: combray-server [reset-link <project> <participant-id>]");
        std::process::exit(2);
    }
    let addr: SocketAddr = std::env::var("COMBRAY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8080".into())
        .parse()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, version = VERSION, "combray-server listening");
    axum::serve(
        listener,
        app(config)?.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await
}

/// Print a one-time link that lets a participant choose a new password for their stores in a
/// project. Only for researchers of that project, after verifying who the participant is.
/// Stand-in until the researcher UI exists.
fn reset_link(config: &Config, project: &str, participant: &str) -> std::io::Result<()> {
    if !valid_project_id(project) || !valid_participant_id(participant) {
        eprintln!("invalid project or participant id");
        std::process::exit(2);
    }
    let token = key_service(config)?
        .create_reset_token(project, participant)
        .map_err(|e| std::io::Error::other(format!("{e:?}")))?;
    let base = std::env::var("COMBRAY_PUBLIC_URL").unwrap_or_default();
    println!("{}/{project}/#reset={token}", base.trim_end_matches('/'));
    eprintln!(
        "Valid for {} hours, once. It works on the device that holds the participant's data.",
        combray_server::keys::RESET_TTL_SECS / 3600
    );
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutting down");
}
