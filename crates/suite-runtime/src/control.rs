//! Private launcher-owned stdin control; not a network or Firebase API. And
//! the one place a stop lands, listened for from the first moment of a start:
//! a stop while the data is still opening must close it cleanly, never end
//! the process where it stands.
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};

use tokio::sync::watch;

use crate::{SuiteRuntimeError, failure};

/// What the launcher's private pipe said.
#[derive(Debug, PartialEq, Eq)]
enum Control {
    /// `FIRENOOK_SHUTDOWN`: the launcher asks for a stop.
    Shutdown,
    /// The pipe ended. A launcher that opts in holds its end for as long as
    /// it runs, so it is gone: killed, or crashed.
    Closed,
}

fn read_control(input: impl BufRead) -> std::io::Result<Control> {
    let mut line = Vec::new();
    input.take(64).read_until(b'\n', &mut line)?;
    if line.is_empty() {
        Ok(Control::Closed)
    } else if line == b"FIRENOOK_SHUTDOWN\n" || line == b"FIRENOOK_SHUTDOWN\r\n" {
        Ok(Control::Shutdown)
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid private shutdown command",
        ))
    }
}

/// The launcher is gone, and nothing reads this process's output any more:
/// on Unix stdout and stderr go to the null device from here, so that no
/// line printed while the data is saved fails (`println!` panics on a closed
/// pipe, and would end the stop part-way, leaving the files to repair).
/// Windows has no safe way to replace them; there the stop's own lines are
/// written without failing instead (`terminal::out` and `terminal::err`).
fn quiet_output() {
    #[cfg(unix)]
    if let Ok(null) = std::fs::OpenOptions::new().write(true).open("/dev/null") {
        let _ = rustix::stdio::dup2_stdout(&null);
        let _ = rustix::stdio::dup2_stderr(&null);
    }
}

struct Stop {
    requested: AtomicBool,
    /// A launcher pipe that failed rather than asked: the stop is an error.
    problem: Mutex<Option<String>>,
    wake: watch::Sender<bool>,
}

fn stop() -> &'static Stop {
    static STOP: OnceLock<Stop> = OnceLock::new();
    STOP.get_or_init(|| Stop {
        requested: AtomicBool::new(false),
        problem: Mutex::new(None),
        wake: watch::channel(false).0,
    })
}

/// Set once a stop is asked for; the start-up work that can end early
/// looks at it.
pub(crate) fn stop_flag() -> &'static AtomicBool {
    &stop().requested
}

pub(crate) fn stop_requested() -> bool {
    stop_flag().load(Ordering::Relaxed)
}

fn request(problem: Option<String>) {
    let stop = stop();
    if let Some(problem) = problem {
        stop.problem
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_or_insert(problem);
    }
    stop.requested.store(true, Ordering::Relaxed);
    stop.wake.send_replace(true);
}

/// Starts listening for a stop: Ctrl-C, SIGTERM, a closed terminal (SIGHUP),
/// or, when the launcher opted in (`FIRENOOK_CONTROL_STDIN=1`, which the npm
/// launcher sets on every platform), its private pipe; the end of that pipe
/// also stops, as a stop asked for would, when the launcher disappears
/// without a word (killed, or crashed). Called first in a start, so that no
/// stop ever takes the default of ending the process mid-write. Needs a Tokio
/// runtime; later calls do nothing.
pub fn listen_for_shutdown() -> Result<(), SuiteRuntimeError> {
    static LISTENING: OnceLock<Result<(), String>> = OnceLock::new();
    LISTENING.get_or_init(install).clone().map_err(failure)
}

fn install() -> Result<(), String> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let listen = |kind: SignalKind, name: &str| {
            signal(kind).map_err(|error| format!("failed to install the {name} handler: {error}"))
        };
        let mut interrupt = listen(SignalKind::interrupt(), "Ctrl-C")?;
        let mut terminate = listen(SignalKind::terminate(), "SIGTERM")?;
        let mut hangup = listen(SignalKind::hangup(), "SIGHUP")?;
        tokio::spawn(async move {
            tokio::select! {
                _ = interrupt.recv() => {}
                _ = terminate.recv() => {}
                _ = hangup.recv() => {}
            }
            request(None);
        });
    }
    #[cfg(not(unix))]
    tokio::spawn(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            request(None);
        }
    });
    if std::env::var_os("FIRENOOK_CONTROL_STDIN").as_deref() == Some(std::ffi::OsStr::new("1")) {
        // A detached OS thread: a blocking Tokio stdin task would keep the
        // runtime from shutting down while stdin stays open.
        std::thread::Builder::new()
            .name("firenook-control".to_owned())
            .spawn(|| match read_control(std::io::stdin().lock()) {
                Ok(Control::Shutdown) => request(None),
                Ok(Control::Closed) => {
                    quiet_output();
                    request(None);
                }
                Err(error) => request(Some(format!("launcher control failed: {error}"))),
            })
            .map_err(|error| format!("cannot monitor launcher pipe: {error}"))?;
    }
    Ok(())
}

/// Waits for a stop (see [`listen_for_shutdown`]); one asked for before the
/// call returns at once.
pub async fn wait_for_shutdown() -> Result<(), SuiteRuntimeError> {
    listen_for_shutdown()?;
    let mut woken = stop().wake.subscribe();
    while !stop_requested() {
        // The sender lives as long as the process: this never ends early.
        if woken.changed().await.is_err() {
            break;
        }
    }
    let problem = stop()
        .problem
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    problem.map_or(Ok(()), |problem| Err(failure(problem)))
}

#[cfg(test)]
mod tests {
    use super::{Control, read_control};

    #[test]
    fn bounded_control_accepts_shutdown_or_disconnect_not_arbitrary_input() {
        for input in [b"FIRENOOK_SHUTDOWN\n".as_slice(), b"FIRENOOK_SHUTDOWN\r\n"] {
            assert_eq!(read_control(input).expect("a stop"), Control::Shutdown);
        }
        // The launcher's end of the pipe closed: it is gone.
        assert_eq!(
            read_control(b"".as_slice()).expect("an end"),
            Control::Closed
        );
        for input in [b"do something\n".as_slice(), &[b'x'; 128]] {
            assert!(read_control(input).is_err());
        }
    }
}
