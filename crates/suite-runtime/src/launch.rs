//! What the npm CLI knew when it started the engine (`--launch-context`).
//!
//! The engine alone cannot tell why a service is not running: the CLI
//! decides the services from `firebase.json` and passes `--only` whenever it
//! starts fewer than all five, so "add it to `--only`" would be wrong for
//! the most common case, a service `firebase.json` does not configure. The
//! CLI says why, and the console turns that into each absent section's
//! reason and fix.

use std::borrow::Cow;
use std::collections::BTreeMap;

use serde::Deserialize;

/// What the npm CLI knew when it started the engine.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchContext {
    /// Why each of the five data services is not started, by name
    /// (`"storage"` → not configured).
    #[serde(default)]
    pub services: BTreeMap<String, LaunchReason>,
    /// `firebase.json` emulator entries skipped because Firenook does not
    /// emulate them (`database`, `hosting`).
    #[serde(default)]
    pub skipped: Vec<String>,
    /// The command the developer ran (`firenook emulators:start`).
    pub command: String,
    /// Its arguments, in order, so a fix can reprint it with one change.
    /// Shown to the developer only; never executed.
    #[serde(default)]
    pub args: Vec<String>,
}

/// Why the CLI did not start a service.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LaunchReason {
    /// `firebase.json` does not configure it.
    NotConfigured,
    /// The developer's `--only` left it out.
    ExcludedByOnly,
    /// A reason a newer CLI gives that this engine does not know; treated
    /// as no reason at all.
    #[serde(other)]
    Other,
}

impl LaunchContext {
    /// Reads the value of `--launch-context`. Invalid JSON is a startup
    /// error naming the flag.
    pub fn from_flag(text: &str) -> Result<Self, String> {
        serde_json::from_str(text)
            .map_err(|error| format!("--launch-context is not a valid launch context: {error}"))
    }

    /// The value the developer gave `--only`, as typed.
    #[must_use]
    pub fn only(&self) -> Option<&str> {
        let mut args = self.args.iter().take_while(|arg| *arg != "--");
        while let Some(arg) = args.next() {
            if arg == "--only" {
                return args.next().map(String::as_str);
            }
            if let Some(value) = arg.strip_prefix("--only=") {
                return Some(value);
            }
        }
        None
    }

    /// The developer's command line with `service` added to `--only`, every
    /// other argument kept; `None` when it has no `--only`.
    #[must_use]
    pub fn with_only(&self, service: &str) -> Option<String> {
        let mut args = self.args.clone();
        let end = args
            .iter()
            .position(|arg| arg == "--")
            .unwrap_or(args.len());
        let extend = |value: &str| {
            let named = value
                .split(',')
                .any(|item| item.trim().split(':').next() == Some(service));
            if named {
                value.to_owned()
            } else if value.is_empty() {
                service.to_owned()
            } else {
                format!("{value},{service}")
            }
        };
        let mut changed = false;
        let mut index = 0;
        while index < end {
            if args[index] == "--only" && index + 1 < end {
                args[index + 1] = extend(&args[index + 1]);
                changed = true;
                break;
            }
            if let Some(value) = args[index].strip_prefix("--only=") {
                args[index] = format!("--only={}", extend(value));
                changed = true;
                break;
            }
            index += 1;
        }
        changed.then(|| {
            std::iter::once(self.command.clone())
                .chain(args.iter().map(|arg| shell_quote(arg).into_owned()))
                .collect::<Vec<_>>()
                .join(" ")
        })
    }
}

/// An argument as a POSIX shell reads it back: as is when it holds nothing
/// the shell interprets, else in single quotes.
fn shell_quote(arg: &str) -> Cow<'_, str> {
    let plain = !arg.is_empty()
        && arg.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'-' | b'_' | b'.' | b'/' | b':' | b'=' | b',' | b'@' | b'%' | b'+'
                )
        });
    if plain {
        Cow::Borrowed(arg)
    } else {
        Cow::Owned(format!("'{}'", arg.replace('\'', r"'\''")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(args: &[&str]) -> LaunchContext {
        LaunchContext {
            services: BTreeMap::new(),
            skipped: Vec::new(),
            command: "firenook emulators:start".to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        }
    }

    #[test]
    fn the_flag_reads_what_the_cli_writes_and_names_itself_when_it_cannot() {
        let parsed = LaunchContext::from_flag(
            r#"{"services":{"storage":"not-configured","auth":"excluded-by-only","pubsub":"unimplemented"},"skipped":["database"],"command":"firenook emulators:start","args":["--only","firestore"],"future":true}"#,
        )
        .expect("parsed");
        assert_eq!(parsed.services["storage"], LaunchReason::NotConfigured);
        assert_eq!(parsed.services["auth"], LaunchReason::ExcludedByOnly);
        assert_eq!(parsed.services["pubsub"], LaunchReason::Other);
        assert_eq!(parsed.skipped, ["database"]);
        assert_eq!(parsed.only(), Some("firestore"));
        let error = LaunchContext::from_flag("{not json").expect_err("refused");
        assert!(error.starts_with("--launch-context "), "{error}");
        let error = LaunchContext::from_flag(r#"{"services":{}}"#).expect_err("refused");
        assert!(error.contains("command"), "{error}");
    }

    #[test]
    fn a_fix_reprints_the_command_with_one_name_added_to_only() {
        let typed = context(&[
            "--only",
            "firestore,auth",
            "--project",
            "demo-app",
            "--import",
            "./seed data",
            "--export-on-exit",
        ]);
        assert_eq!(
            typed.with_only("storage").as_deref(),
            Some(
                "firenook emulators:start --only firestore,auth,storage --project demo-app --import './seed data' --export-on-exit"
            )
        );
        let equals = context(&["--only=firestore:default", "-P", "demo-app"]);
        assert_eq!(
            equals.with_only("functions").as_deref(),
            Some("firenook emulators:start --only=firestore:default,functions -P demo-app")
        );
        assert_eq!(equals.only(), Some("firestore:default"));
        // A name already there is not repeated.
        assert_eq!(
            context(&["--only", "storage"])
                .with_only("storage")
                .as_deref(),
            Some("firenook emulators:start --only storage")
        );
        // An exec command after `--` is kept as typed and never searched.
        let exec = LaunchContext {
            command: "firenook emulators:exec".to_owned(),
            ..context(&["--only", "auth", "--", "npm", "test", "--only", "x"])
        };
        assert_eq!(
            exec.with_only("pubsub").as_deref(),
            Some("firenook emulators:exec --only auth,pubsub -- npm test --only x")
        );
        let script = LaunchContext {
            command: "firenook emulators:exec".to_owned(),
            ..context(&["npm test && echo 'done'", "--only", "auth"])
        };
        assert_eq!(
            script.with_only("storage").as_deref(),
            Some(r"firenook emulators:exec 'npm test && echo '\''done'\''' --only auth,storage")
        );
        assert_eq!(context(&["--project", "demo-app"]).with_only("auth"), None);
    }
}
