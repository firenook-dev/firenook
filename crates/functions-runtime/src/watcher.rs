//! File watching: the recursive source watcher behind reloads (dotfiles,
//! logs, `node_modules`, `venv` and the configured `ignore` globs left out,
//! debounced one second like the official chokidar setup), and the same
//! watcher non-recursive with a path filter for env files.
//!
//! The debounce waits for one second of quiet after the last change, as the
//! official setup's trailing `debounce` does, not one second after the
//! first: a write that lands as a window closes (truncate, then the new
//! bytes) is read whole, once it is done, rather than half written.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use notify::{RecursiveMode, Watcher as _};

use crate::RuntimeError;

const DEBOUNCE: Duration = Duration::from_secs(1);
/// The longest a burst that never goes quiet (a build writing for minutes)
/// holds its changes back.
const LONGEST_WAIT: Duration = Duration::from_secs(5);

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
        let root = directory.to_path_buf();
        let mut watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                let Ok(event) = event else {
                    return;
                };
                let kept = changed_paths(event, &root, mode, &keep);
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
                            // Debounce: collect notifications until a second
                            // passes without one (at most `LONGEST_WAIT` after
                            // the first), then fire once.
                            let mut changed: Vec<PathBuf> = Vec::new();
                            let mut add = |paths: Vec<PathBuf>| {
                                for path in paths {
                                    if !changed.contains(&path) {
                                        changed.push(path);
                                    }
                                }
                            };
                            add(first);
                            let began = std::time::Instant::now();
                            let mut quiet_from = began;
                            loop {
                                let now = std::time::Instant::now();
                                let remaining = (quiet_from + DEBOUNCE)
                                    .min(began + LONGEST_WAIT)
                                    .saturating_duration_since(now);
                                if remaining.is_zero() {
                                    break;
                                }
                                match receiver.recv_timeout(remaining) {
                                    Ok(paths) => {
                                        add(paths);
                                        quiet_from = std::time::Instant::now();
                                    }
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

/// The paths one notification reports, `keep` applied. A rescan notice
/// (macOS `FSEvents`' "must scan subdirectories" when its queue overflows under
/// heavy disk activity, or notify's own) says events were lost and anything
/// may have changed: a recursive watch reports its directory, a flat watch
/// every entry `keep` accepts that is there now (the consumers compare
/// content, so an unchanged file reads as unchanged). Without this a save
/// during a burst of other disk work went unheard.
fn changed_paths(
    event: notify::Event,
    root: &Path,
    mode: WatchMode,
    keep: &dyn Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    if event.need_rescan() {
        return match mode {
            WatchMode::Recursive => vec![root.to_path_buf()],
            WatchMode::NonRecursive => {
                let mut entries: Vec<PathBuf> = std::fs::read_dir(root)
                    .map(|entries| {
                        entries
                            .filter_map(Result::ok)
                            .map(|entry| entry.path())
                            .filter(|path| keep(path))
                            .collect()
                    })
                    .unwrap_or_default();
                entries.sort();
                entries
            }
        };
    }
    if !matches!(
        event.kind,
        notify::EventKind::Modify(_) | notify::EventKind::Create(_) | notify::EventKind::Remove(_)
    ) {
        return Vec::new();
    }
    event.paths.into_iter().filter(|path| keep(path)).collect()
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

    #[test]
    fn a_rescan_notice_reports_what_may_have_changed() {
        use notify::event::{EventKind, Flag, ModifyKind};
        let directory = tempfile::tempdir().expect("a directory");
        let root = directory.path();
        std::fs::write(root.join(".env"), "A=1\n").expect("written");
        std::fs::write(root.join("index.js"), "x").expect("written");
        let env_only = |path: &Path| {
            path.file_name()
                .is_some_and(|name| is_env_file(&name.to_string_lossy()))
        };
        let rescan = || notify::Event::new(EventKind::Other).set_flag(Flag::Rescan);
        // A recursive watch: its directory, whatever `keep` says of it.
        assert_eq!(
            changed_paths(rescan(), root, WatchMode::Recursive, &|_| false),
            [root.to_path_buf()],
        );
        // A flat watch: every entry it keeps that is there now.
        assert_eq!(
            changed_paths(rescan(), root, WatchMode::NonRecursive, &env_only),
            [root.join(".env")],
        );
        // An ordinary change still reports only its own kept paths, and
        // other kinds of event report nothing.
        let modified = notify::Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(root.join("index.js"))
            .add_path(root.join(".env"));
        assert_eq!(
            changed_paths(modified, root, WatchMode::NonRecursive, &env_only),
            [root.join(".env")],
        );
        let accessed = notify::Event::new(EventKind::Access(notify::event::AccessKind::Any))
            .add_path(root.join(".env"));
        assert_eq!(
            changed_paths(accessed, root, WatchMode::NonRecursive, &env_only),
            Vec::<PathBuf>::new(),
        );
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

    /// Changes 300 ms apart for longer than the debounce are one burst,
    /// reported after the last of them: the second counts from the newest
    /// change, not the first.
    #[tokio::test]
    async fn a_burst_that_keeps_going_arrives_once_after_it_ends() {
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
        tokio::time::sleep(Duration::from_millis(200)).await;
        let names = [".env.a", ".env.b", ".env.c", ".env.d", ".env.e", ".env.f"];
        for name in names {
            std::fs::write(root.join(name), "A=1\n").expect("written");
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let changed = tokio::time::timeout(Duration::from_secs(10), receiver.recv())
            .await
            .expect("a burst")
            .expect("paths");
        let mut reported: Vec<String> = changed
            .iter()
            .filter_map(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .collect();
        reported.sort();
        assert_eq!(reported, names);
        assert!(
            tokio::time::timeout(Duration::from_millis(1500), receiver.recv())
                .await
                .is_err(),
            "one burst"
        );
        watcher.stop();
    }
}
