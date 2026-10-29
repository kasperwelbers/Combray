//! Project configs and their participant policy. For now configs are JSON files placed in the
//! data directory by the operator (`projects/{id}.json`); later they are signed and registered
//! from the researcher tool.

use std::path::Path;

use regex::Regex;
use serde::Deserialize;

/// Names that cannot be project ids, because the web client is served at `/{project}/`.
const RESERVED: &[&str] = &["api", "assets"];

pub fn valid_project_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !RESERVED.contains(&id)
}

/// Participant ids are pseudonymous codes from the researcher, never names or emails.
pub fn valid_participant_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// Whether participants of a project come with an id from their link.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ParticipantMode {
    /// Anyone with the project link takes part, without an id. No password reset.
    Anonymous,
    /// An id from the link is used when there is one.
    #[default]
    Optional,
    /// Only participants with a (valid) id can take part.
    Required,
}

#[derive(Debug, Default, Deserialize)]
struct ParticipantsConfig {
    #[serde(default)]
    mode: ParticipantMode,
    /// A regular expression the whole id must match, e.g. `P[0-9]{4}`.
    pattern: Option<String>,
}

#[derive(Debug)]
pub struct Project {
    pub config: serde_json::Value,
    pub mode: ParticipantMode,
    pattern: Option<Regex>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParticipantError {
    Required,
    Invalid,
}

#[derive(Debug)]
pub enum LoadError {
    NotFound,
    Invalid,
    Io,
}

impl Project {
    pub fn from_json(config: serde_json::Value) -> Result<Project, LoadError> {
        let participants: ParticipantsConfig = match config.get("participants") {
            Some(p) => serde_json::from_value(p.clone()).map_err(|_| LoadError::Invalid)?,
            None => ParticipantsConfig::default(),
        };
        let pattern = participants
            .pattern
            .map(|p| {
                regex::RegexBuilder::new(&format!("^(?:{p})$"))
                    .size_limit(1 << 20)
                    .build()
            })
            .transpose()
            .map_err(|_| LoadError::Invalid)?;
        Ok(Project {
            config,
            mode: participants.mode,
            pattern,
        })
    }

    /// The participant id to store with a new store, checked against the project's policy.
    pub fn check_participant<'a>(
        &self,
        id: Option<&'a str>,
    ) -> Result<Option<&'a str>, ParticipantError> {
        let id = match (self.mode, id) {
            (ParticipantMode::Anonymous, _) => return Ok(None),
            (ParticipantMode::Required, None) => return Err(ParticipantError::Required),
            (_, None) => return Ok(None),
            (_, Some(id)) => id,
        };
        let allowed =
            valid_participant_id(id) && self.pattern.as_ref().is_none_or(|p| p.is_match(id));
        if allowed {
            Ok(Some(id))
        } else {
            Err(ParticipantError::Invalid)
        }
    }
}

pub async fn load(data_dir: &Path, id: &str) -> Result<Project, LoadError> {
    if !valid_project_id(id) {
        return Err(LoadError::NotFound);
    }
    let path = data_dir.join("projects").join(format!("{id}.json"));
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(LoadError::NotFound),
        Err(_) => return Err(LoadError::Io),
    };
    let value = serde_json::from_slice(&bytes).map_err(|_| LoadError::Invalid)?;
    Project::from_json(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(participants: serde_json::Value) -> Project {
        Project::from_json(json!({ "id": "willow", "participants": participants })).unwrap()
    }

    #[test]
    fn reserves_names_used_by_the_web_client() {
        assert!(valid_project_id("willow"));
        assert!(!valid_project_id("api"));
        assert!(!valid_project_id("assets"));
        assert!(!valid_project_id("Willow"));
    }

    #[test]
    fn applies_the_participant_mode_and_pattern() {
        let anonymous = project(json!({ "mode": "anonymous" }));
        assert_eq!(anonymous.check_participant(Some("P1234")), Ok(None));

        let optional = Project::from_json(json!({ "id": "willow" })).unwrap();
        assert_eq!(optional.mode, ParticipantMode::Optional);
        assert_eq!(optional.check_participant(None), Ok(None));
        assert_eq!(optional.check_participant(Some("abc-1")), Ok(Some("abc-1")));
        assert_eq!(
            optional.check_participant(Some("a b")),
            Err(ParticipantError::Invalid)
        );

        let required = project(json!({ "mode": "required", "pattern": "P[0-9]{4}" }));
        assert_eq!(
            required.check_participant(None),
            Err(ParticipantError::Required)
        );
        assert_eq!(required.check_participant(Some("P1234")), Ok(Some("P1234")));
        // The pattern must match the whole id.
        assert_eq!(
            required.check_participant(Some("xP1234")),
            Err(ParticipantError::Invalid)
        );
        assert_eq!(
            required.check_participant(Some("P12345")),
            Err(ParticipantError::Invalid)
        );
    }

    #[test]
    fn rejects_invalid_policies() {
        assert!(Project::from_json(json!({ "participants": { "mode": "sometimes" } })).is_err());
        assert!(Project::from_json(json!({ "participants": { "pattern": "(" } })).is_err());
    }
}
