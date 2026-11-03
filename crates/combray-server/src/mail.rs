//! Sending sign-in emails to researchers. Over SMTP in production; for development, mails can
//! be written to an outbox directory instead. Addresses and contents are never logged.

use std::path::PathBuf;

use lettre::message::header::ContentType;
use lettre::transport::smtp::AsyncSmtpTransport;
use lettre::{AsyncTransport, Message, Tokio1Executor};

pub struct Smtp {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: lettre::message::Mailbox,
}

pub enum Mailer {
    Smtp(Box<Smtp>),
    /// Write each mail as a file (development only; the files contain sign-in codes).
    Outbox(PathBuf),
    Disabled,
}

/// How to send mail, from the environment. Its `Debug` leaves out the SMTP URL, which can hold
/// a password.
#[derive(Clone, Default)]
pub enum MailConfig {
    /// `COMBRAY_SMTP_URL` (e.g. `smtps://user:password@smtp.uni.nl:465`) with `COMBRAY_MAIL_FROM`.
    Smtp { url: String, from: String },
    /// `COMBRAY_MAIL_OUTBOX`: a directory to write each mail to (development only; the files
    /// contain sign-in codes).
    Outbox(PathBuf),
    /// Without either, researchers cannot sign in.
    #[default]
    Disabled,
}

impl std::fmt::Debug for MailConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MailConfig::Smtp { from, .. } => write!(f, "Smtp {{ from: {from:?} }}"),
            MailConfig::Outbox(dir) => write!(f, "Outbox({dir:?})"),
            MailConfig::Disabled => write!(f, "Disabled"),
        }
    }
}

impl MailConfig {
    pub fn from_env() -> MailConfig {
        // Empty counts as unset, so docker compose can pass `${COMBRAY_SMTP_URL:-}`.
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        match (
            var("COMBRAY_SMTP_URL"),
            var("COMBRAY_MAIL_FROM"),
            var("COMBRAY_MAIL_OUTBOX"),
        ) {
            (Some(url), Some(from), _) => MailConfig::Smtp { url, from },
            (_, _, Some(dir)) => MailConfig::Outbox(PathBuf::from(dir)),
            _ => MailConfig::Disabled,
        }
    }
}

impl Mailer {
    pub fn new(config: &MailConfig) -> Mailer {
        match config {
            MailConfig::Smtp { url, from } => {
                match (
                    AsyncSmtpTransport::<Tokio1Executor>::from_url(url),
                    from.parse(),
                ) {
                    (Ok(builder), Ok(from)) => Mailer::Smtp(Box::new(Smtp {
                        transport: builder.build(),
                        from,
                    })),
                    _ => {
                        tracing::error!(
                            error_class = "mail_config",
                            "COMBRAY_SMTP_URL or COMBRAY_MAIL_FROM is invalid; email sign-in is off"
                        );
                        Mailer::Disabled
                    }
                }
            }
            MailConfig::Outbox(dir) => Mailer::Outbox(dir.clone()),
            MailConfig::Disabled => Mailer::Disabled,
        }
    }

    pub fn enabled(&self) -> bool {
        !matches!(self, Mailer::Disabled)
    }

    /// Whether mails go to a folder instead of being sent (development).
    pub fn is_outbox(&self) -> bool {
        matches!(self, Mailer::Outbox(_))
    }

    pub async fn send(&self, to: &str, subject: &str, body: String) -> Result<(), MailError> {
        match self {
            Mailer::Smtp(smtp) => {
                let Smtp { transport, from } = smtp.as_ref();
                let to = to.parse().map_err(|_| MailError::Address)?;
                let message = Message::builder()
                    .from(from.clone())
                    .to(to)
                    .subject(subject)
                    .header(ContentType::TEXT_PLAIN)
                    .body(body)
                    .map_err(|_| MailError::Message)?;
                transport.send(message).await.map(|_| ()).map_err(|_| {
                    tracing::error!(error_class = "smtp", "could not send a sign-in email");
                    MailError::Send
                })
            }
            Mailer::Outbox(dir) => {
                let suffix = crate::util::random::<6>().map_err(|_| MailError::Send)?;
                let name = format!(
                    "{}-{}.txt",
                    crate::util::now_secs(),
                    crate::accounts::b64(&suffix)
                );
                let text = format!("To: {to}\nSubject: {subject}\n\n{body}");
                tokio::fs::create_dir_all(dir)
                    .await
                    .map_err(|_| MailError::Send)?;
                tokio::fs::write(dir.join(name), text)
                    .await
                    .map_err(|_| MailError::Send)
            }
            Mailer::Disabled => Err(MailError::Disabled),
        }
    }
}

/// Why a mail was not sent. Never carries the address or the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailError {
    Disabled,
    Address,
    Message,
    Send,
}
