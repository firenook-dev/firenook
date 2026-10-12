//! Cloud Tasks' part of ⌘K: queues by id (exact, then prefix, then
//! substring), and a task by its exact name or short name across queues
//! (the engine's name maps: one lookup per queue).

use std::sync::atomic::{AtomicBool, Ordering};

use crate::entity::EntityRef;
use crate::late::Late;
use crate::messaging::TasksConsole;
use crate::search::{SearchHit, SearchSource, SourceHits, match_rank};

/// Hits per kind.
const PER_KIND: usize = 5;

/// Cloud Tasks' search source.
pub(crate) struct TasksSearch {
    late: Late<TasksConsole>,
}

impl TasksSearch {
    pub(crate) const fn new(late: Late<TasksConsole>) -> Self {
        Self { late }
    }
}

impl SearchSource for TasksSearch {
    fn section(&self) -> &'static str {
        "tasks"
    }

    fn search(&self, text: &str, limit: usize, cancel: &AtomicBool) -> SourceHits {
        let Ok(console) = self.late.get() else {
            return SourceHits::default();
        };
        let lower = text.to_lowercase();
        let per_kind = limit.min(PER_KIND);
        let mut ranked: Vec<((u8, u8, String), SearchHit)> = Vec::new();
        // Tasks by exact name, newest first.
        for (key, id, name) in console.runtime.find_tasks(text, per_kind) {
            let Some(parts) = console.runtime.queue_parts(&key) else {
                continue;
            };
            let entity = EntityRef::tasks_task(
                &parts.project,
                &parts.location,
                &parts.queue,
                &id.to_string(),
            );
            let short = name.rsplit('/').next().unwrap_or(&name).to_owned();
            ranked.push((
                (0, 0, name.clone()),
                SearchHit {
                    kind: entity.kind,
                    key: entity.key,
                    title: short,
                    detail: Some(format!("Task in {} ({})", parts.queue, parts.location)),
                },
            ));
        }
        if cancel.load(Ordering::Acquire) {
            return SourceHits {
                hits: ranked.into_iter().map(|(_, hit)| hit).collect(),
                partial: true,
            };
        }
        let mut queues = Vec::new();
        for key in console.runtime.queue_keys() {
            let Some(parts) = console.runtime.queue_parts(&key) else {
                continue;
            };
            if let Some(rank) = match_rank(&parts.queue, &lower) {
                let entity = EntityRef::tasks_queue(&parts.project, &parts.location, &parts.queue);
                queues.push((
                    (rank, 1, entity.key.clone()),
                    SearchHit {
                        kind: entity.kind,
                        key: entity.key,
                        title: parts.queue.clone(),
                        detail: Some(format!("Queue in {}, {}", parts.project, parts.location)),
                    },
                ));
            }
        }
        queues.sort_by(|left, right| left.0.cmp(&right.0));
        ranked.extend(queues.into_iter().take(per_kind));
        ranked.sort_by(|left, right| left.0.cmp(&right.0));
        SourceHits {
            hits: ranked.into_iter().map(|(_, hit)| hit).collect(),
            partial: false,
        }
    }
}
