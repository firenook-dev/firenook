//! Work the console starts and the service owns: the folder index walk,
//! sorted views, thumbnail decodes, archive listings, export streams and the
//! session sweep. None is ever detached: stopping the service flips one
//! flag and awaits them all, so nothing still runs when the final flush
//! makes the metadata durable.

use std::future::Future;
use std::sync::Mutex;

use tokio::sync::watch;
use tokio::task::JoinSet;

/// The console's tasks and their stop switch.
#[derive(Debug)]
pub(crate) struct ConsoleTasks {
    set: Mutex<JoinSet<()>>,
    stop: watch::Sender<bool>,
}

impl Default for ConsoleTasks {
    fn default() -> Self {
        Self {
            set: Mutex::new(JoinSet::new()),
            stop: watch::channel(false).0,
        }
    }
}

impl ConsoleTasks {
    /// Whether the service is stopping: a task checks this between steps
    /// and ends early.
    pub(crate) fn stopping(&self) -> bool {
        *self.stop.borrow()
    }

    /// Runs `work` on the blocking pool. Refused (false) once the service is
    /// stopping, or outside a runtime.
    pub(crate) fn spawn_blocking(&self, work: impl FnOnce() + Send + 'static) -> bool {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return false;
        };
        let mut set = self
            .set
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.stopping() {
            return false;
        }
        // Finished tasks are reaped here, so a long session keeps no
        // results it never reads.
        while set.try_join_next().is_some() {}
        set.spawn_blocking_on(work, &handle);
        true
    }

    /// Runs `work` on the runtime as one of the console's tasks. Refused
    /// (false) once the service is stopping, or outside a runtime. The work
    /// ends itself when [`Self::stopped`] resolves.
    pub(crate) fn spawn(&self, work: impl Future<Output = ()> + Send + 'static) -> bool {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return false;
        };
        let mut set = self
            .set
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.stopping() {
            return false;
        }
        while set.try_join_next().is_some() {}
        set.spawn_on(work, &handle);
        true
    }

    /// Resolves once the service is stopping.
    pub(crate) fn stopped(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut receiver = self.stop.subscribe();
        async move {
            while !*receiver.borrow_and_update() {
                if receiver.changed().await.is_err() {
                    return;
                }
            }
        }
    }

    /// Runs `work` on the blocking pool and hands back its answer. `None`
    /// once the service is stopping (or outside a runtime).
    pub(crate) fn run_blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Option<tokio::sync::oneshot::Receiver<T>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.spawn_blocking(move || {
            // Nobody waiting any more (the request went away) is fine.
            let _ = sender.send(work());
        })
        .then_some(receiver)
    }

    /// Asks every task to stop without waiting (the runtime was dropped).
    pub(crate) fn signal_stop(&self) {
        self.stop.send_replace(true);
    }

    /// Asks every task to stop and waits for each to end. Later spawns are
    /// refused; a second call returns at once.
    pub(crate) async fn stop(&self) {
        self.stop.send_replace(true);
        let mut set = std::mem::take(
            &mut *self
                .set
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        while set.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn stop_waits_for_running_tasks_and_refuses_new_ones() {
        let tasks = Arc::new(ConsoleTasks::default());
        let finished = Arc::new(AtomicBool::new(false));
        let (started, ready) = std::sync::mpsc::channel();
        {
            let finished = Arc::clone(&finished);
            let tasks_for_work = Arc::clone(&tasks);
            assert!(tasks.spawn_blocking(move || {
                started.send(()).expect("started");
                while !tasks_for_work.stopping() {
                    std::thread::sleep(Duration::from_millis(1));
                }
                // A step in progress finishes before the task ends.
                std::thread::sleep(Duration::from_millis(30));
                finished.store(true, Ordering::SeqCst);
            }));
        }
        ready.recv().expect("the task runs");
        tasks.stop().await;
        assert!(
            finished.load(Ordering::SeqCst),
            "stop returns after the task ends"
        );
        assert!(!tasks.spawn_blocking(|| {}), "a stopped set refuses work");
        tasks.stop().await;
    }
}
