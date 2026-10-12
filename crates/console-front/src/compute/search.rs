//! What ⌘K finds in compute's sections: functions (by id, name or entry
//! point) and Extensions instances (by id, display name or ref).
//!
//! Search runs on the blocking pool; the runtime's lists sit behind async
//! locks held for microseconds, so the source reads them by blocking on
//! the runtime that owns them. A few hundred functions are well inside the
//! search budget.

use std::sync::atomic::{AtomicBool, Ordering};

use firenook_functions_runtime::console::FunctionView;

use super::ComputeControl;
use super::filters::kind_word;
use crate::late::Late;
use crate::search::{SEARCH_BUDGET, SearchHit, SearchSource, SourceHits, match_rank};

/// Compute's ⌘K source.
pub(crate) struct ComputeSearch {
    control: Late<ComputeControl>,
}

impl ComputeSearch {
    pub(crate) const fn new(control: Late<ComputeControl>) -> Self {
        Self { control }
    }
}

impl SearchSource for ComputeSearch {
    fn section(&self) -> &'static str {
        "functions"
    }

    fn search(&self, text: &str, limit: usize, cancel: &AtomicBool) -> SourceHits {
        let Ok(control) = self.control.get() else {
            return SourceHits::default();
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return SourceHits::default();
        };
        let text = text.to_lowercase();
        let functions = handle.block_on(control.runtime.functions());
        let mut ranked: Vec<(u8, SearchHit)> = Vec::new();
        let mut partial = false;
        for (examined, function) in functions.iter().enumerate() {
            if examined >= SEARCH_BUDGET || cancel.load(Ordering::Acquire) {
                partial = true;
                break;
            }
            if let Some(rank) = function_rank(function, &text) {
                ranked.push((rank, function_hit(function)));
            }
        }
        if let Some(extensions) = &control.extensions {
            for (id, instance) in handle.block_on(extensions.instances()) {
                if cancel.load(Ordering::Acquire) {
                    partial = true;
                    break;
                }
                let display = instance
                    .loaded
                    .as_ref()
                    .and_then(|loaded| loaded.spec.get("displayName"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                let rank = [
                    Some(id.as_str()),
                    display.as_deref(),
                    Some(&instance.status.written),
                ]
                .into_iter()
                .flatten()
                .filter_map(|candidate| match_rank(candidate, &text))
                .min();
                if let Some(rank) = rank {
                    ranked.push((
                        rank,
                        SearchHit {
                            kind: "extensions.instance".to_owned(),
                            key: id.clone(),
                            title: display.unwrap_or_else(|| id.clone()),
                            detail: Some(format!("Extension · {}", instance.status.written)),
                        },
                    ));
                }
            }
        }
        ranked.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.title.cmp(&right.1.title)));
        SourceHits {
            hits: ranked.into_iter().take(limit).map(|(_, hit)| hit).collect(),
            partial,
        }
    }
}

fn function_rank(function: &FunctionView, text: &str) -> Option<u8> {
    [&function.id, &function.name, &function.entry_point]
        .into_iter()
        .filter_map(|candidate| match_rank(candidate, text))
        .min()
}

fn function_hit(function: &FunctionView) -> SearchHit {
    SearchHit {
        kind: "functions.function".to_owned(),
        key: function.id.clone(),
        title: function.name.clone(),
        detail: Some(format!(
            "{} · {} · {}",
            function.region,
            kind_word(function.kind),
            function.codebase
        )),
    }
}
