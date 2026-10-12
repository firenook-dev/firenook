//! Pub/Sub's part of ⌘K: topics and subscriptions by name or id (exact,
//! then prefix, then substring), schemas, scheduled functions, and a
//! message by its id, found by a binary search in each topic's history
//! ring. At most five hits per kind; the best of every kind come first.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::entity::EntityRef;
use crate::late::Late;
use crate::messaging::PubsubConsole;
use crate::search::{SEARCH_BUDGET, SearchHit, SearchSource, SourceHits, match_rank};

/// Hits per kind.
const PER_KIND: usize = 5;
/// How often a walk looks at its cancel flag.
const CANCEL_EVERY: usize = 256;

/// Pub/Sub's search source.
pub(crate) struct PubsubSearch {
    late: Late<PubsubConsole>,
}

impl PubsubSearch {
    pub(crate) const fn new(late: Late<PubsubConsole>) -> Self {
        Self { late }
    }
}

/// One candidate: its match rank (exact, prefix, substring), its kind's
/// place, then its text.
struct Ranked {
    order: (u8, u8, String),
    hit: SearchHit,
}

fn hit(entity: EntityRef, title: String, detail: Option<String>) -> SearchHit {
    SearchHit {
        kind: entity.kind,
        key: entity.key,
        title,
        detail,
    }
}

/// The best rank of `text` (lowercased) in a resource's full name and id.
fn rank(name: &str, id: &str, text: &str) -> Option<u8> {
    [match_rank(id, text), match_rank(name, text)]
        .into_iter()
        .flatten()
        .min()
}

/// One search's walk: what it found, and how much of its budget it spent.
struct Walk<'a> {
    console: &'a PubsubConsole,
    text: String,
    per_kind: usize,
    cancel: &'a AtomicBool,
    examined: usize,
    partial: bool,
    ranked: Vec<Ranked>,
}

impl Walk<'_> {
    /// Counts one examined item; `true` once the walk must stop.
    fn stop(&mut self) -> bool {
        self.examined += 1;
        let over = (self.examined.is_multiple_of(CANCEL_EVERY)
            && self.cancel.load(Ordering::Acquire))
            || self.examined > SEARCH_BUDGET;
        self.partial |= over;
        over
    }

    /// Keeps the best `per_kind` of one kind.
    fn keep(&mut self, mut kind: Vec<Ranked>) {
        kind.sort_by(|left, right| left.order.cmp(&right.order));
        self.ranked.extend(kind.into_iter().take(self.per_kind));
    }

    /// A message id: the topics whose ring keeps it.
    fn messages(&mut self) {
        if self.text.is_empty() || !self.text.bytes().all(|byte| byte.is_ascii_digit()) {
            return;
        }
        let Ok(id) = self.text.parse::<u64>() else {
            return;
        };
        let found = self
            .console
            .runtime
            .broker()
            .topics_with_message(id, self.per_kind)
            .into_iter()
            .map(|topic| {
                let short = topic.rsplit('/').next().unwrap_or(&topic).to_owned();
                Ranked {
                    order: (0, 0, topic.clone()),
                    hit: hit(
                        EntityRef::pubsub_message(&topic, &id.to_string()),
                        format!("Message {id}"),
                        Some(format!("in {short}")),
                    ),
                }
            })
            .collect();
        self.keep(found);
    }

    /// Topics or subscriptions (`collection`), noting each project seen.
    fn resources(&mut self, collection: &str, projects: &mut BTreeSet<String>) {
        let (place, noun) = if collection == "topics" {
            (1, "Topic")
        } else {
            (2, "Subscription")
        };
        let mut found = Vec::new();
        for (project, id) in self.console.runtime.broker().resource_ids(collection) {
            if self.stop() {
                break;
            }
            let name = format!("projects/{project}/{collection}/{id}");
            if let Some(rank) = rank(&name, &id, &self.text) {
                let entity = if collection == "topics" {
                    EntityRef::pubsub_topic(&name)
                } else {
                    EntityRef::pubsub_subscription(&name)
                };
                found.push(Ranked {
                    order: (rank, place, name.clone()),
                    hit: hit(entity, id.clone(), Some(format!("{noun} in {project}"))),
                });
            }
            projects.insert(project);
        }
        self.keep(found);
    }

    /// Schemas of `projects`.
    fn schemas(&mut self, projects: &BTreeSet<String>) {
        let mut found = Vec::new();
        'projects: for project in projects {
            for schema in self.console.runtime.broker().schemas_view(project) {
                if self.stop() {
                    break 'projects;
                }
                if let Some(rank) = rank(&schema.name, &schema.id, &self.text) {
                    found.push(Ranked {
                        order: (rank, 3, schema.name.clone()),
                        hit: hit(
                            EntityRef::pubsub_schema(&schema.name),
                            schema.id.clone(),
                            Some(format!(
                                "Avro schema · {} revision{}",
                                schema.revisions,
                                if schema.revisions == 1 { "" } else { "s" }
                            )),
                        ),
                    });
                }
            }
        }
        self.keep(found);
    }

    /// Scheduled functions, by id or name.
    fn schedules(&mut self) {
        let found = self
            .console
            .runtime
            .schedules_view()
            .into_iter()
            .filter_map(|view| {
                let rank = rank(&view.function_id, &view.function_name, &self.text)?;
                Some(Ranked {
                    order: (rank, 4, view.function_id.clone()),
                    hit: hit(
                        EntityRef::pubsub_schedule(&view.function_id),
                        view.function_name.clone(),
                        Some(format!("Schedule · {}", view.expression)),
                    ),
                })
            })
            .collect();
        self.keep(found);
    }
}

impl SearchSource for PubsubSearch {
    fn section(&self) -> &'static str {
        "pubsub"
    }

    fn search(&self, text: &str, limit: usize, cancel: &AtomicBool) -> SourceHits {
        let Ok(console) = self.late.get() else {
            return SourceHits::default();
        };
        let mut walk = Walk {
            console: &console,
            text: text.to_lowercase(),
            per_kind: limit.min(PER_KIND),
            cancel,
            examined: 0,
            partial: false,
            ranked: Vec::new(),
        };
        walk.messages();
        let mut projects = BTreeSet::new();
        walk.resources("topics", &mut projects);
        walk.resources("subscriptions", &mut projects);
        projects.insert(console.runtime.project().to_owned());
        walk.schemas(&projects);
        walk.schedules();
        let mut ranked = walk.ranked;
        ranked.sort_by(|left, right| left.order.cmp(&right.order));
        SourceHits {
            hits: ranked.into_iter().map(|ranked| ranked.hit).collect(),
            partial: walk.partial,
        }
    }
}
