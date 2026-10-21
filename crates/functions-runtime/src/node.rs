//! The Node a codebase asks for, and the Node its functions run on.
//!
//! The official emulator takes the version a codebase asks for from
//! firebase.json's `runtime`, else from package.json's `engines.node`, runs
//! the functions on the Node that runs the emulator whatever they ask for,
//! and warns when the two majors differ (firebase-tools 15.22.0
//! `runtimes/node/index.js` `getNodeBinary`). The runtime warns in the same
//! case, in its own words ([`NodeRequest::mismatch`]). `engines.node` may
//! also be an npm range (`>=22`, `22 || 24`): the warning then comes when the
//! Node is outside it, where the official emulator refuses to load the
//! codebase.
use std::fmt;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;

/// How long `node --version` may take before the runtime stops waiting.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// A Node release version, as `node --version` prints it (`v24.20.0`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct NodeVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl NodeVersion {
    /// `v24.20.0` or `24.20.0`; a pre-release or build suffix is dropped.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let core = text.strip_prefix('v').unwrap_or(text);
        let core = core.split(['-', '+']).next()?;
        let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
        let version = Self {
            major: parts.next()??,
            minor: parts.next()??,
            patch: parts.next()??,
        };
        parts.next().is_none().then_some(version)
    }

    const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }
}

impl fmt::Display for NodeVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The version of the Node at `node`, from `node --version`; `None` when it
/// does not run or prints something else.
pub async fn probe(node: &Path) -> Option<NodeVersion> {
    let output = tokio::time::timeout(
        PROBE_TIMEOUT,
        tokio::process::Command::new(node)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    NodeVersion::parse(&String::from_utf8_lossy(&output.stdout))
}

/// Where a codebase says which Node it asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestOrigin {
    /// firebase.json's `runtime` for the codebase, as written (`nodejs22`).
    Runtime(String),
    /// package.json's `engines.node`.
    Engines,
}

/// The Node a codebase asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRequest {
    /// An npm version range: `22`, `>=20`, `20 || 22`.
    pub range: String,
    pub origin: RequestOrigin,
}

impl NodeRequest {
    /// What the codebase in `source_dir` asks for: firebase.json's
    /// `runtime` first (a Node one, `nodejs<major>`), else package.json's
    /// `engines.node`. `None` when it asks for neither.
    #[must_use]
    pub fn of(runtime: Option<&str>, source_dir: &Path) -> Option<Self> {
        if let Some(runtime) = runtime {
            return runtime.strip_prefix("nodejs").map(|major| Self {
                range: major.to_owned(),
                origin: RequestOrigin::Runtime(runtime.to_owned()),
            });
        }
        let text = std::fs::read_to_string(source_dir.join("package.json")).ok()?;
        let package: Value = serde_json::from_str(&text).ok()?;
        let range = package.get("engines")?.get("node")?.as_str()?.trim();
        (!range.is_empty()).then(|| Self {
            range: range.to_owned(),
            origin: RequestOrigin::Engines,
        })
    }

    /// The warning when the functions in `directory` (as the log shows the
    /// codebase, relative to the project) run on a Node this request does
    /// not admit; `None` when it admits it or the range is not one this
    /// reads.
    #[must_use]
    pub fn mismatch(&self, version: NodeVersion, directory: &str) -> Option<String> {
        if satisfies(&self.range, version)? {
            return None;
        }
        let asks = match &self.origin {
            RequestOrigin::Engines => format!(
                "{} asks for Node {} in engines.node",
                if directory == "." {
                    "package.json".to_owned()
                } else {
                    format!("{directory}/package.json")
                },
                self.range
            ),
            RequestOrigin::Runtime(runtime) => format!(
                "firebase.json asks for {runtime} for {} (its runtime)",
                if directory == "." {
                    "the project folder"
                } else {
                    directory
                }
            ),
        };
        // nvm takes a major as it is; for a range, the developer picks.
        let nvm = if self.range.parse::<u64>().is_ok() {
            format!(" (with nvm: nvm use {})", self.range)
        } else {
            String::new()
        };
        Some(format!(
            "{asks}, but these functions run on Node {version}, the Node running the emulators; start the emulators with Node {} to run them on the Node they ask for{nvm}",
            self.range
        ))
    }
}

/// A comparator of an npm range, against a full version.
#[derive(Debug, Clone, Copy)]
enum Bound {
    AtLeast(NodeVersion),
    Above(NodeVersion),
    Below(NodeVersion),
    AtMost(NodeVersion),
    Exactly(NodeVersion),
}

impl Bound {
    fn admits(self, version: NodeVersion) -> bool {
        match self {
            Self::AtLeast(bound) => version >= bound,
            Self::Above(bound) => version > bound,
            Self::Below(bound) => version < bound,
            Self::AtMost(bound) => version <= bound,
            Self::Exactly(bound) => version == bound,
        }
    }
}

/// A version in a range, each part a number or a wildcard (`x`, `X`, `*`
/// or absent); after a wildcard every part is one.
#[derive(Debug, Clone, Copy)]
struct Partial {
    major: Option<u64>,
    minor: Option<u64>,
    patch: Option<u64>,
}

impl Partial {
    fn parse(text: &str) -> Option<Self> {
        let text = text.strip_prefix('v').unwrap_or(text);
        let text = text.split(['-', '+']).next().unwrap_or_default();
        let mut parts = Vec::new();
        for part in text.split('.') {
            parts.push(match part {
                "x" | "X" | "*" | "" => None,
                number => Some(number.parse::<u64>().ok()?),
            });
        }
        if parts.len() > 3 {
            return None;
        }
        parts.resize(3, None);
        let wild = parts.iter().position(Option::is_none).unwrap_or(3);
        if parts[wild..].iter().any(Option::is_some) {
            return None;
        }
        Some(Self {
            major: parts[0],
            minor: parts[1],
            patch: parts[2],
        })
    }

    /// The lowest version it stands for, wildcards as 0.
    fn floor(self) -> NodeVersion {
        NodeVersion::new(
            self.major.unwrap_or(0),
            self.minor.unwrap_or(0),
            self.patch.unwrap_or(0),
        )
    }

    /// The first version above everything it stands for; `None` for `*`
    /// or a full version (which stands for itself).
    fn ceiling(self) -> Option<NodeVersion> {
        match (self.major, self.minor, self.patch) {
            (Some(major), None, _) => Some(NodeVersion::new(major + 1, 0, 0)),
            (Some(major), Some(minor), None) => Some(NodeVersion::new(major, minor + 1, 0)),
            _ => None,
        }
    }
}

/// The bounds one comparator of a range stands for (`>=22`, `^22.1`,
/// `22.x`), as npm's semver reads them; `None` when it is not one.
fn bounds(comparator: &str) -> Option<Vec<Bound>> {
    let (operator, version) = comparator
        .find(|character: char| character.is_ascii_digit() || "vxX*".contains(character))
        .map_or((comparator, ""), |at| comparator.split_at(at));
    let partial = Partial::parse(version)?;
    if partial.major.is_none() {
        // `*`, `x`, `>=*`: every version (`<*` and `>*`: none).
        return match operator {
            "" | "=" | ">=" | "<=" | "^" | "~" => Some(Vec::new()),
            "<" | ">" => Some(vec![Bound::Below(NodeVersion::new(0, 0, 0))]),
            _ => None,
        };
    }
    let floor = partial.floor();
    let ceiling = partial.ceiling();
    Some(match operator {
        "" | "=" => match ceiling {
            Some(ceiling) => vec![Bound::AtLeast(floor), Bound::Below(ceiling)],
            None => vec![Bound::Exactly(floor)],
        },
        ">=" => vec![Bound::AtLeast(floor)],
        ">" => match ceiling {
            Some(ceiling) => vec![Bound::AtLeast(ceiling)],
            None => vec![Bound::Above(floor)],
        },
        "<" => vec![Bound::Below(floor)],
        "<=" => match ceiling {
            Some(ceiling) => vec![Bound::Below(ceiling)],
            None => vec![Bound::AtMost(floor)],
        },
        // `~22.1.4` keeps the minor; `~22` is `22.x`.
        "~" => {
            let ceiling = if partial.minor.is_some() {
                NodeVersion::new(floor.major, floor.minor + 1, 0)
            } else {
                NodeVersion::new(floor.major + 1, 0, 0)
            };
            vec![Bound::AtLeast(floor), Bound::Below(ceiling)]
        }
        // `^` keeps the major. (npm keeps the minor of a 0.x version too;
        // no Node that runs the emulators is 0.x, so both read the same.)
        "^" => vec![
            Bound::AtLeast(floor),
            Bound::Below(NodeVersion::new(floor.major + 1, 0, 0)),
        ],
        _ => return None,
    })
}

/// Whether `version` is in the npm range `range`: alternatives joined by
/// `||`, each a set of comparators that must all admit it, or a hyphen range
/// (`20 - 22`). `None` when the range is not one this reads (a tag such as
/// `lts/*`).
#[must_use]
pub fn satisfies(range: &str, version: NodeVersion) -> Option<bool> {
    let mut any = false;
    for alternative in range.split("||") {
        let tokens = comparators(alternative);
        let mut admitted = Vec::new();
        if let [low, dash, high] = tokens.as_slice()
            && dash == "-"
        {
            let low = Partial::parse(low)?;
            let high = Partial::parse(high)?;
            admitted.push(Bound::AtLeast(low.floor()));
            if high.major.is_some() {
                admitted.push(match high.ceiling() {
                    Some(ceiling) => Bound::Below(ceiling),
                    None => Bound::AtMost(high.floor()),
                });
            }
        } else {
            for token in &tokens {
                admitted.extend(bounds(token)?);
            }
        }
        any |= admitted.iter().all(|bound| bound.admits(version));
    }
    Some(any)
}

/// The comparators of one alternative, with an operator written apart from
/// its version (`>= 22`) joined back to it.
fn comparators(alternative: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut operator: Option<&str> = None;
    for token in alternative.split_whitespace() {
        if matches!(token, ">" | ">=" | "<" | "<=" | "=" | "~" | "^") {
            operator = Some(token);
        } else {
            tokens.push(format!("{}{token}", operator.take().unwrap_or_default()));
        }
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn v(major: u64, minor: u64, patch: u64) -> NodeVersion {
        NodeVersion::new(major, minor, patch)
    }

    #[test]
    fn versions_read_as_node_prints_them() {
        assert_eq!(NodeVersion::parse("v24.20.0\n"), Some(v(24, 20, 0)));
        assert_eq!(NodeVersion::parse("26.9.0"), Some(v(26, 9, 0)));
        assert_eq!(NodeVersion::parse("v27.0.0-nightly2026"), Some(v(27, 0, 0)));
        for text in ["", "v24", "24.20", "v24.20.0.1", "node"] {
            assert_eq!(NodeVersion::parse(text), None, "{text}");
        }
        assert_eq!(v(22, 23, 3).to_string(), "22.23.3");
    }

    #[test]
    fn ranges_admit_what_npm_admits() {
        let cases: &[(&str, NodeVersion, bool)] = &[
            // A bare major, as firebase init writes it, and its spellings.
            ("24", v(24, 20, 0), true),
            ("24", v(22, 23, 3), false),
            ("24", v(25, 0, 0), false),
            ("22.x", v(22, 0, 0), true),
            ("22.*", v(23, 0, 0), false),
            ("v22", v(22, 1, 0), true),
            ("=22", v(22, 1, 0), true),
            ("22.4", v(22, 4, 9), true),
            ("22.4", v(22, 5, 0), false),
            ("22.4.1", v(22, 4, 1), true),
            ("22.4.1", v(22, 4, 2), false),
            ("*", v(26, 9, 0), true),
            ("x", v(20, 0, 0), true),
            // Comparators, also with a space after the operator.
            (">=22", v(26, 9, 0), true),
            (">=22", v(20, 20, 2), false),
            (">= 22", v(24, 0, 0), true),
            (">22", v(22, 99, 0), false),
            (">22", v(23, 0, 0), true),
            (">22.1", v(22, 2, 0), true),
            (">22.1.0", v(22, 1, 1), true),
            ("<24", v(24, 0, 0), false),
            ("<24", v(23, 11, 1), true),
            ("<=24", v(24, 20, 0), true),
            ("<=24", v(25, 0, 0), false),
            ("<=24.1", v(24, 1, 7), true),
            ("<=24.1.0", v(24, 1, 1), false),
            (">=18 <21", v(24, 20, 0), false),
            (">=18 <21", v(20, 1, 0), true),
            (">=24.20.0 <25", v(24, 20, 0), true),
            // Tilde, caret, alternatives and hyphen ranges.
            ("~22", v(22, 9, 0), true),
            ("~22.1", v(22, 2, 0), false),
            ("~22.1.4", v(22, 1, 9), true),
            ("~22.1.4", v(22, 1, 3), false),
            ("^22", v(22, 23, 3), true),
            ("^22.5", v(22, 4, 0), false),
            ("^22.5", v(23, 0, 0), false),
            ("^22.5.1", v(22, 9, 0), true),
            ("20 || 22", v(22, 1, 0), true),
            ("20 || 22", v(24, 1, 0), false),
            (">=20.0.0 || >=22.0.0", v(26, 0, 0), true),
            ("20 - 22", v(22, 9, 0), true),
            ("20 - 22", v(23, 0, 0), false),
            ("20 - 22.1", v(22, 1, 9), true),
            ("20 - 22.1.0", v(22, 1, 1), false),
            ("20.5 - 22", v(20, 4, 0), false),
            ("<*", v(24, 0, 0), false),
        ];
        for (range, version, admitted) in cases {
            assert_eq!(
                satisfies(range, *version),
                Some(*admitted),
                "{range} against {version}"
            );
        }
        for range in ["lts/*", "latest", "22.x.1", "24.1.2.3", "node22", "~>22"] {
            assert_eq!(satisfies(range, v(24, 0, 0)), None, "{range}");
        }
    }

    fn codebase(package: &str) -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("a directory");
        std::fs::write(directory.path().join("package.json"), package).expect("package.json");
        directory
    }

    #[test]
    fn a_codebase_asks_through_firebase_json_first_then_engines() {
        let declared = codebase(r#"{"engines":{"node":"22"}}"#);
        assert_eq!(
            NodeRequest::of(None, declared.path()),
            Some(NodeRequest {
                range: "22".to_owned(),
                origin: RequestOrigin::Engines
            })
        );
        // firebase.json's runtime wins, as in the official emulator.
        assert_eq!(
            NodeRequest::of(Some("nodejs24"), declared.path()),
            Some(NodeRequest {
                range: "24".to_owned(),
                origin: RequestOrigin::Runtime("nodejs24".to_owned())
            })
        );
        assert_eq!(NodeRequest::of(Some("python312"), declared.path()), None);
        for package in [
            r#"{"name":"x"}"#,
            r#"{"engines":{"node":""}}"#,
            r#"{"engines":{"npm":"12"}}"#,
            "not json",
        ] {
            assert_eq!(
                NodeRequest::of(None, codebase(package).path()),
                None,
                "{package}"
            );
        }
        let empty = tempfile::tempdir().expect("a directory");
        assert_eq!(NodeRequest::of(None, empty.path()), None);
    }

    #[test]
    fn the_warning_says_what_was_asked_for_and_what_the_functions_run_on() {
        let engines = NodeRequest {
            range: "22".to_owned(),
            origin: RequestOrigin::Engines,
        };
        assert_eq!(engines.mismatch(v(22, 23, 3), "functions"), None);
        assert_eq!(
            engines.mismatch(v(24, 20, 0), "functions").as_deref(),
            Some(
                "functions/package.json asks for Node 22 in engines.node, but these functions run on Node 24.20.0, the Node running the emulators; start the emulators with Node 22 to run them on the Node they ask for (with nvm: nvm use 22)"
            )
        );
        assert!(engines.mismatch(v(26, 9, 0), ".").is_some_and(|text| {
            text.starts_with("package.json asks for Node 22 in engines.node, ")
        }));
        let runtime = NodeRequest {
            range: "24".to_owned(),
            origin: RequestOrigin::Runtime("nodejs24".to_owned()),
        };
        assert_eq!(
            runtime.mismatch(v(26, 9, 0), "functions/api").as_deref(),
            Some(
                "firebase.json asks for nodejs24 for functions/api (its runtime), but these functions run on Node 26.9.0, the Node running the emulators; start the emulators with Node 24 to run them on the Node they ask for (with nvm: nvm use 24)"
            )
        );
        let range = NodeRequest {
            range: ">=18 <21".to_owned(),
            origin: RequestOrigin::Engines,
        };
        assert_eq!(range.mismatch(v(20, 1, 0), "functions"), None);
        assert_eq!(
            range.mismatch(v(24, 20, 0), "functions").as_deref(),
            Some(
                "functions/package.json asks for Node >=18 <21 in engines.node, but these functions run on Node 24.20.0, the Node running the emulators; start the emulators with Node >=18 <21 to run them on the Node they ask for"
            )
        );
        // A range this does not read: nothing is claimed about it.
        let tag = NodeRequest {
            range: "lts/*".to_owned(),
            origin: RequestOrigin::Engines,
        };
        assert_eq!(tag.mismatch(v(24, 20, 0), "functions"), None);
    }

    #[tokio::test]
    async fn the_probe_reads_the_version_a_node_prints() {
        assert_eq!(
            probe(Path::new("/nonexistent/firenook-test-node")).await,
            None
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let directory = tempfile::tempdir().expect("a directory");
            let node = directory.path().join("node");
            std::fs::write(&node, "#!/bin/sh\necho v26.9.0\n").expect("a script");
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755))
                .expect("executable");
            assert_eq!(probe(&node).await, Some(v(26, 9, 0)));
            let failing = directory.path().join("failing");
            std::fs::write(&failing, "#!/bin/sh\necho v26.9.0\nexit 3\n").expect("a script");
            std::fs::set_permissions(&failing, std::fs::Permissions::from_mode(0o755))
                .expect("executable");
            assert_eq!(probe(&failing).await, None);
        }
    }
}
