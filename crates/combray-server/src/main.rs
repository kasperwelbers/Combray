use std::net::SocketAddr;

use combray_server::accounts::Accounts;
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
    if args.first().map(String::as_str) == Some("researcher")
        || args.first().map(String::as_str) == Some("project")
    {
        return researchers(&config, &args);
    }
    if !args.is_empty() {
        eprintln!("{USAGE}");
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

const USAGE: &str = "usage: combray-server [command]

  reset-link <project> <participant-id>   a one-time password reset link for a participant
  researcher add <email>                  create a researcher account (they sign in by email)
  researcher list                         list researcher accounts
  researcher remove <email>               delete an account, its passkeys and memberships
  researcher reset-key <email>            forget a researcher's key after they lost both their
                                          passkeys and recovery code; colleagues grant access again
  project add-researcher <project> <email>
                                          make a researcher a member of a project (the first
                                          member creates the project key on the key page)";

/// Researcher and project membership commands, for the server operator. Until projects are
/// registered from the studio, the operator adds the first member of each project.
fn researchers(config: &Config, args: &[String]) -> std::io::Result<()> {
    let Some(research) = &config.research else {
        eprintln!("set COMBRAY_PUBLIC_URL and COMBRAY_KEYS_URL to use researcher accounts");
        std::process::exit(2);
    };
    let accounts = Accounts::open(&research.research_db)?;
    let fail = |e| -> std::io::Result<()> {
        eprintln!("failed: {e:?}");
        std::process::exit(1);
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["researcher", "add", email] => match accounts.add_researcher(email) {
            Ok(_) => {
                println!("{email} can now sign in at {}", research.keys_url);
                Ok(())
            }
            Err(e) => fail(e),
        },
        ["researcher", "list"] => match accounts.list_researchers() {
            Ok(rows) => {
                for (email, has_key, passkeys) in rows {
                    let key = if has_key { "key set up" } else { "no key yet" };
                    println!("{email}\t{key}\t{passkeys} passkey(s)");
                }
                Ok(())
            }
            Err(e) => fail(e),
        },
        ["researcher", "remove", email] => accounts.remove_researcher(email).or_else(fail),
        ["researcher", "reset-key", email] => accounts.reset_researcher_key(email).or_else(fail),
        ["project", "add-researcher", project, email] => {
            if !valid_project_id(project)
                || !config
                    .data_dir
                    .join("projects")
                    .join(format!("{project}.json"))
                    .exists()
            {
                eprintln!("no such project: {project}");
                std::process::exit(2);
            }
            let id = match accounts.add_researcher(email) {
                Ok(id) => id,
                Err(e) => return fail(e),
            };
            match accounts.add_member(project, &id) {
                Ok(()) => {
                    println!("{email} is a member of {project}");
                    Ok(())
                }
                Err(e) => fail(e),
            }
        }
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
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
