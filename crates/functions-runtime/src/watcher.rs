//! File watching: the recursive source watcher behind reloads (dotfiles,
//! logs, `node_modules`, `venv` and the configured `ignore` globs left out,
//! debounced one second like the official chokidar setup), and the same
//! watcher non-recursive with a path filter for env files.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use notify::{RecursiveMode, Watcher as _};

use crate::RuntimeError;

const DEBOUNCE: Duration = Duration::from_secs(1);

/// Whether a watch covers subdirectories.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchMode {
    Recursive,
    /// The directory's own entries only.
    NonRecursive,
}

/// A running watcher; stopping it (or dropping it) ends the notifications.
pub struct SourceWatcher {
    _watcher: notify::RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}

impl SourceWatcher {
    /// Watches `directory`; `on_change` runs once per debounced burst with
    /// the changed paths `keep` accepted during it (each once, in arrival
    /// order). `keep` sees absolute paths as the platform reports them.
    pub fn start(
        directory: &Path,
        mode: WatchMode,
        keep: impl Fn(&Path) -> bool + Send + Sync + 'static,
        on_change: impl Fn(Vec<PathBuf>) + Send + Sync + 'static,
    ) -> Result<Self, RuntimeError> {
        // Notifications arrive on a plain thread; `on_change` is entered on
        // the runtime that started the watcher.
        let handle = tokio::runtime::Handle::current();
        let (sender, receiver) = std::sync::mpsc::channel::<Vec<PathBuf>>();
        let mut watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                let Ok(event) = event else {
                    return;
                };
                if !matches!(
                    event.kind,
                    notify::EventKind::Modify(_)
                        | notify::EventKind::Create(_)
                        | notify::EventKind::Remove(_)
                ) {
                    return;
                }
                let kept: Vec<PathBuf> =
                    event.paths.into_iter().filter(|path| keep(path)).collect();
                if !kept.is_empty() {
                    let _ = sender.send(kept);
                }
            })
            .map_err(|error| RuntimeError(format!("failed to create a file watcher: {error}")))?;
        let recursive = match mode {
            WatchMode::Recursive => RecursiveMode::Recursive,
            WatchMode::NonRecursive => RecursiveMode::NonRecursive,
        };
        watcher.watch(directory, recursive).map_err(|error| {
            RuntimeError(format!("failed to watch {}: {error}", directory.display()))
        })?;
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_for_thread = Arc::clone(&stopped);
        std::thread::Builder::new()
            .name("firenook-functions-watch".to_owned())
            .spawn(move || {
                while !stopped_for_thread.load(Ordering::SeqCst) {
                    match receiver.recv_timeout(Duration::from_millis(500)) {
                        Ok(first) => {
                            // Debounce: collect every notification for one
                            // second after the first, then fire once.
                            let mut changed: Vec<PathBuf> = Vec::new();
                            let mut add = |paths: Vec<PathBuf>| {
                                for path in paths {
                                    if !changed.contains(&path) {
                                        changed.push(path);
                                    }
                                }
                            };
                            add(first);
                            let deadline = std::time::Instant::now() + DEBOUNCE;
                            loop {
                                let remaining =
                                    deadline.saturating_duration_since(std::time::Instant::now());
                                if remaining.is_zero() {
                                    break;
                                }
                                match receiver.recv_timeout(remaining) {
                                    Ok(paths) => add(paths),
                                    Err(_) => break,
                                }
                            }
                            if stopped_for_thread.load(Ordering::SeqCst) {
                                break;
                            }
                            let _guard = handle.enter();
                            on_change(changed);
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .map_err(|error| RuntimeError(format!("failed to start the watch thread: {error}")))?;
        Ok(Self {
            _watcher: watcher,
            stopped,
        })
    }

    /// Ends the notifications.
    pub fn stop(self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

/// The reload watcher's filter: whether a change under `root` is ignored.
/// `root` is tried as given and canonicalized, since the platform may
/// report a path through a different spelling of the same directory.
pub(crate) fn source_filter(
    root: &Path,
    ignore: &[String],
) -> impl Fn(&Path) -> bool + Send + Sync + 'static {
    let roots = {
        let mut roots = vec![root.to_path_buf()];
        if let Ok(canonical) = root.canonicalize()
            && canonical != root
        {
            roots.push(canonical);
        }
        roots
    };
    let ignore = ignore.to_vec();
    move |path: &Path| {
        let root = roots
            .iter()
            .find(|root| path.starts_with(root))
            .unwrap_or(&roots[0]);
        !ignored(root, path, &ignore)
    }
}

fn ignored(root: &Path, path: &Path, ignore: &[String]) -> bool {
    let relative: PathBuf = path
        .strip_prefix(root)
        .map_or_else(|_| path.to_path_buf(), Path::to_path_buf);
    let components: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    if components.iter().any(|component| {
        component.starts_with('.') || component == "node_modules" || component == "venv"
    }) {
        return true;
    }
    if components.last().is_some_and(|name| {
        std::path::Path::new(name)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("log"))
    }) {
        return true;
    }
    let name = components.last().cloned().unwrap_or_default();
    ignore.iter().any(|pattern| {
        glob_matches(pattern, &name) || glob_matches(pattern, &relative.to_string_lossy())
    })
}

/// Whether a file name is a Functions env file: `.env`, `.env.<suffix>` or
/// `.secret.local`.
#[must_use]
pub fn is_env_file(name: &str) -> bool {
    name == ".env" || name.starts_with(".env.") || name == ".secret.local"
}

/// Minimal glob support for `ignore` entries: `*` and `**` wildcards.
fn glob_matches(pattern: &str, candidate: &str) -> bool {
    fn matches(pattern: &[u8], candidate: &[u8]) -> bool {
        match (pattern.first(), candidate.first()) {
            (None, None) => true,
            (Some(b'*'), _) => {
                let rest = &pattern[1..];
                (0..=candidate.len()).any(|skip| matches(rest, &candidate[skip..]))
            }
            (Some(p), Some(c)) if p == c => matches(&pattern[1..], &candidate[1..]),
            _ => false,
        }
    }
    matches(pattern.as_bytes(), candidate.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_dotfiles_logs_and_node_modules() {
        let root = Path::new("/src");
        assert!(ignored(root, Path::new("/src/.env.local"), &[]));
        assert!(ignored(
            root,
            Path::new("/src/node_modules/x/index.js"),
            &[]
        ));
        assert!(ignored(root, Path::new("/src/firebase-debug.log"), &[]));
        assert!(!ignored(root, Path::new("/src/index.js"), &[]));
        assert!(ignored(
            root,
            Path::new("/src/secret.local"),
            &["*.local".to_owned()]
        ));
    }

    #[test]
    fn the_source_filter_reads_paths_under_either_spelling_of_the_root() {
        let directory = tempfile::Builder::new()
            .prefix(".hidden-parent-")
            .tempdir()
            .expect("a directory");
        let root = directory.path().to_path_buf();
        let keep = source_filter(&root, &[]);
        assert!(keep(&root.join("index.js")));
        let canonical = root.canonicalize().expect("canonical");
        assert!(keep(&canonical.join("index.js")));
        assert!(!keep(&canonical.join(".env")));
    }

    #[test]
    fn env_file_names() {
        assert!(is_env_file(".env"));
        assert!(is_env_file(".env.local"));
        assert!(is_env_file(".env.demo-project"));
        assert!(is_env_file(".secret.local"));
        assert!(!is_env_file(".envrc"));
        assert!(!is_env_file("env"));
    }

    #[tokio::test]
    async fn changed_paths_arrive_once_per_burst() {
        let directory = tempfile::tempdir().expect("a directory");
        let root = directory.path().canonicalize().expect("canonical");
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let watcher = SourceWatcher::start(
            &root,
            WatchMode::NonRecursive,
            |path| {
                path.file_name()
                    .is_some_and(|name| is_env_file(&name.to_string_lossy()))
            },
            move |paths| {
                let _ = sender.send(paths);
            },
        )
        .expect("watching");
        // Some platforms deliver the watch's first events late.
        tokio::time::sleep(Duration::from_millis(200)).await;
        std::fs::write(root.join(".env"), "A=1\n").expect("written");
        std::fs::write(root.join("index.js"), "x").expect("written");
        std::fs::write(root.join(".env"), "A=2\n").expect("written");
        let changed = tokio::time::timeout(Duration::from_secs(10), receiver.recv())
            .await
            .expect("a burst")
            .expect("paths");
        let names: Vec<String> = changed
            .iter()
            .filter_map(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .collect();
        assert_eq!(names, [".env"]);
        watcher.stop();
    }
}
