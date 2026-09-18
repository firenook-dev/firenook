//! Source watching for reloads: a recursive watcher on the codebase
//! directory, ignoring dotfiles, logs, `node_modules`, `venv` and the
//! configured `ignore` globs, debounced one second like the official
//! chokidar setup.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use notify::{RecursiveMode, Watcher as _};

use crate::RuntimeError;

const DEBOUNCE: Duration = Duration::from_secs(1);

/// A running watcher; dropping or stopping it ends the notifications.
pub(crate) struct SourceWatcher {
    _watcher: notify::RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}

impl SourceWatcher {
    /// Starts watching `directory`; `on_change` runs once per debounced burst.
    pub(crate) fn start(
        directory: &Path,
        ignore: &[String],
        on_change: impl Fn() + Send + Sync + 'static,
    ) -> Result<Self, RuntimeError> {
        // Notifications arrive on a plain thread; `on_change` is entered on
        // the runtime that started the watcher.
        let handle = tokio::runtime::Handle::current();
        let (sender, receiver) = std::sync::mpsc::channel::<()>();
        let root = directory.to_path_buf();
        let ignore: Vec<String> = ignore.to_vec();
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
                if event
                    .paths
                    .iter()
                    .any(|path| !ignored(&root, path, &ignore))
                {
                    let _ = sender.send(());
                }
            })
            .map_err(|error| RuntimeError(format!("failed to create a file watcher: {error}")))?;
        watcher
            .watch(directory, RecursiveMode::Recursive)
            .map_err(|error| {
                RuntimeError(format!("failed to watch {}: {error}", directory.display()))
            })?;
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_for_thread = Arc::clone(&stopped);
        std::thread::Builder::new()
            .name("fireside-functions-watch".to_owned())
            .spawn(move || {
                while !stopped_for_thread.load(Ordering::SeqCst) {
                    match receiver.recv_timeout(Duration::from_millis(500)) {
                        Ok(()) => {
                            // Debounce: swallow every notification for one second
                            // after the first, then fire once.
                            let deadline = std::time::Instant::now() + DEBOUNCE;
                            loop {
                                let remaining =
                                    deadline.saturating_duration_since(std::time::Instant::now());
                                if remaining.is_zero() {
                                    break;
                                }
                                if receiver.recv_timeout(remaining).is_err() {
                                    break;
                                }
                            }
                            if stopped_for_thread.load(Ordering::SeqCst) {
                                break;
                            }
                            let _guard = handle.enter();
                            on_change();
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

    pub(crate) fn stop(self) {
        self.stopped.store(true, Ordering::SeqCst);
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
}
