//! Bounded log replay with an atomic replay/live boundary and owned lifetimes.
//!
//! The history is a [`ReplayRing`]: one sequenced buffer that the official
//! Logging WebSocket replays from (the newest 1,024 records, byte for byte).
//! Every line also reaches the console's sink, when a console runs, as the
//! structured [`LogInput`] its producer described.
use std::io::Write as _;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse as _, Response};
use axum::routing::get;
use futures_util::{Sink, SinkExt as _, StreamExt as _};
use serde_json::{Map, Value as JsonValue, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::{Semaphore, broadcast, watch};

use super::{LOG_REPLAY_CAPACITY, LogRecord, lock};
use crate::console_input::{Audience, ConsoleSink, LogInput, LogLevel};
use crate::replay::{ReplayRing, RingBudget, RingLimits, random_epoch};

pub(super) const MAXIMUM_RECORD_BYTES: usize = 8192;
/// What the log ring keeps: the records the official UI replays, each at
/// most [`MAXIMUM_RECORD_BYTES`], as `benchmarks/phase-b-logging.json` bounds
/// them.
const LOG_RING: RingLimits = RingLimits {
    entries: LOG_REPLAY_CAPACITY,
    bytes: LOG_REPLAY_CAPACITY * MAXIMUM_RECORD_BYTES,
    floor: 256,
};
pub(super) const MAXIMUM_SUBSCRIBERS: usize = 4;
const SEND_DEADLINE: Duration = Duration::from_secs(30);
/// What the official feed carries in place of a record it cannot keep.
const OMISSION: &str = "Oversized log record omitted; diagnostic payload was not retained";
/// The level of that omission, as the suite's lines spell it.
const OMISSION_LEVEL: &str = "WARN";

/// Bounded Logging WebSocket producer and router.
#[derive(Clone)]
pub struct LoggingRuntime {
    pub(super) state: LoggingState,
    // Router/session state has only a receiver: losing the final producer closes
    // subscribers instead of allowing the sessions to keep their own owner alive.
    _owner: Arc<watch::Sender<bool>>,
}

impl Default for LoggingRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl LoggingRuntime {
    /// Creates an empty bounded log buffer.
    #[must_use]
    pub fn new() -> Self {
        let (owner, shutdown) = watch::channel(false);
        Self {
            state: LoggingState {
                // Named apart from the console's own log rings (`logs`,
                // `logs.problems`) in the memory report.
                history: ReplayRing::new(
                    "logging",
                    LOG_RING,
                    random_epoch(),
                    &RingBudget::shared(),
                ),
                shutdown,
                slots: Arc::new(Semaphore::new(MAXIMUM_SUBSCRIBERS)),
                file: Arc::new(Mutex::new(None)),
                console: Arc::new(RwLock::new(None)),
            },
            _owner: Arc::new(owner),
        }
    }

    /// Appends every record from now on to `path` as one text line
    /// (`[LEVEL] [timestamp] [emulator] message`), the `--debug-log` file.
    /// The file is opened for append and never truncated or deleted by the
    /// suite.
    pub fn set_file_sink(&self, path: &Path) -> std::io::Result<()> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        *lock(&self.state.file) = Some(file);
        Ok(())
    }

    /// Router accepting bounded log WebSocket connections on any path.
    pub fn application(&self) -> Router {
        Router::new()
            .fallback(get(upgrade))
            .with_state(self.state.clone())
    }

    /// Router attached to the owning suite's explicit shutdown signal.
    pub fn application_with_shutdown(&self, shutdown: watch::Receiver<bool>) -> Router {
        let mut state = self.state.clone();
        state.shutdown = shutdown;
        Router::new().fallback(get(upgrade)).with_state(state)
    }

    /// Installs the console's sink: from now on every line meant for the
    /// console reaches it. Without one (`--no-ui`), nothing is built or kept
    /// for the console.
    pub fn set_console_sink(&self, sink: Arc<dyn ConsoleSink>) {
        *self
            .state
            .console
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sink);
    }

    /// Records one line for every audience it is meant for: for
    /// [`Audience::Everyone`], the official Logging record and the debug-log
    /// line exactly as the suite has always written them (its legacy text,
    /// level and emulator, one record per printed line), plus the trigger id,
    /// extension instance and payload the official feed carries for function
    /// output; then the console's sink, when one is installed.
    ///
    /// # Panics
    /// Panics if the internal string-only log representation cannot serialize.
    pub fn emit(&self, input: LogInput) {
        if input.audience == Audience::Everyone {
            let level = input.legacy_level.unwrap_or_else(|| input.level.legacy());
            let emulator = input.legacy_emulator.unwrap_or(input.service.as_str());
            let extras = RecordExtras {
                function: input.function.as_deref(),
                extension: input.extension.as_deref(),
                user: input.payload.as_ref().filter(|payload| payload.is_object()),
            };
            match &input.legacy_text {
                Some(text) => {
                    for line in printed_lines(text) {
                        self.official(level, Some(emulator), line, &extras);
                    }
                }
                None => self.official(level, Some(emulator), &input.message, &extras),
            }
        }
        if let Some(sink) = self.console_sink() {
            sink.accept(input);
        }
    }

    /// Records one bounded complete entry, or an explicit payload-free omission,
    /// and hands the console the same line (service `hub` when no emulator is
    /// named).
    ///
    /// # Panics
    /// Panics if the internal string-only log representation cannot serialize.
    pub fn record(&self, level: &str, emulator: Option<&str>, message: impl Into<String>) {
        let message = message.into();
        self.official(level, emulator, &message, &RecordExtras::default());
        if let Some(sink) = self.console_sink() {
            sink.accept(LogInput {
                level: LogLevel::parse(level),
                service: emulator.unwrap_or("hub").to_owned(),
                message,
                ..LogInput::default()
            });
        }
    }

    /// The console's sink, when one is installed: every clone of this
    /// runtime shares it.
    #[must_use]
    pub fn console_sink(&self) -> Option<Arc<dyn ConsoleSink>> {
        self.state
            .console
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// One official record (or its omission) and its debug-log line. The
    /// file keeps the whole line even when the feed's record is omitted for
    /// its size, as the official debug log does; a record whose labels are
    /// invalid is omitted in both.
    fn official(
        &self,
        level: &str,
        emulator: Option<&str>,
        message: &str,
        extras: &RecordExtras<'_>,
    ) {
        let valid_labels = level.len() <= 64 && emulator.is_none_or(|name| name.len() <= 64);
        let mut record = if valid_labels && message.len() <= MAXIMUM_RECORD_BYTES {
            record(level, emulator, message, extras)
        } else {
            omitted()
        };
        let mut encoded = serde_json::to_string(&record).expect("LogRecord is JSON serializable");
        if encoded.len() > MAXIMUM_RECORD_BYTES {
            record = omitted();
            encoded = serde_json::to_string(&record).expect("omission is JSON serializable");
        }
        let encoded: Arc<str> = encoded.into();
        if let Some(file) = lock(&self.state.file).as_mut() {
            // The file keeps its own upper-case `[LEVEL]` format, whatever
            // case the feed writes.
            let (file_level, file_message) = if valid_labels {
                (level, message)
            } else {
                (OMISSION_LEVEL, record.message.as_str())
            };
            let line = format!(
                "[{file_level}] [{}] [{}] {file_message}\n",
                record.timestamp,
                emulator.unwrap_or("suite"),
            );
            // A full disk or a removed file must not stop the suite; the
            // in-memory replay keeps serving the UI.
            let _ = file.write_all(line.as_bytes());
        }
        // The ring snapshots and subscribes under the lock it pushes with:
        // no gap or duplicate at the boundary, and producers never wait on
        // network I/O.
        self.state.history.push((), encoded);
    }

    /// Current bounded record count.
    #[must_use]
    pub fn len(&self) -> usize {
        self.state.history.len()
    }

    /// Whether no entries have been recorded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// What the official feed carries for function output beyond the emulator
/// name: the keys the Google Emulator UI filters and renders by.
#[derive(Default)]
struct RecordExtras<'a> {
    /// `data.metadata.function.name`.
    function: Option<&'a str>,
    /// `data.metadata.extension.instanceId`.
    extension: Option<&'a str>,
    /// `data.user`: a structured logger call's fields.
    user: Option<&'a JsonValue>,
}

/// The lines of a legacy text, one official record each, split as a worker's
/// output is read: at line breaks (a `\r\n` counts as one), with no record
/// for a final break. A text without a break is one record, unchanged.
fn printed_lines(text: &str) -> Box<dyn Iterator<Item = &str> + '_> {
    if text.contains('\n') {
        Box::new(text.lines())
    } else {
        Box::new(std::iter::once(text))
    }
}

fn record(
    level: &str,
    emulator: Option<&str>,
    message: &str,
    extras: &RecordExtras<'_>,
) -> LogRecord {
    let mut data = Map::new();
    if let Some(name) = emulator {
        let mut metadata = Map::new();
        metadata.insert("emulator".to_owned(), json!({ "name": name }));
        metadata.insert("message".to_owned(), JsonValue::from(message));
        if let Some(function) = extras.function {
            metadata.insert("function".to_owned(), json!({ "name": function }));
        }
        if let Some(extension) = extras.extension {
            metadata.insert("extension".to_owned(), json!({ "instanceId": extension }));
        }
        data.insert("metadata".to_owned(), JsonValue::Object(metadata));
        if let Some(user) = extras.user {
            data.insert("user".to_owned(), user.clone());
        }
    }
    let now = OffsetDateTime::now_utc();
    LogRecord {
        // The official Logging feed writes levels in lower case (`info`,
        // `warn`), and the Emulator UI styles each line by that class; the
        // suite's producers spell them `INFO`, `WARN`.
        level: level.to_ascii_lowercase(),
        data: JsonValue::Object(data),
        message: message.to_owned(),
        timestamp: now
            .format(&Rfc3339)
            .unwrap_or_else(|_| now.unix_timestamp().to_string()),
    }
}

fn omitted() -> LogRecord {
    record(
        OMISSION_LEVEL,
        Some("hub"),
        OMISSION,
        &RecordExtras::default(),
    )
}

#[derive(Clone)]
pub(super) struct LoggingState {
    pub(super) history: ReplayRing<()>,
    pub(super) slots: Arc<Semaphore>,
    shutdown: watch::Receiver<bool>,
    file: Arc<Mutex<Option<std::fs::File>>>,
    /// The console's sink, shared by every clone of the runtime.
    console: Arc<RwLock<Option<Arc<dyn ConsoleSink>>>>,
}

async fn upgrade(State(state): State<LoggingState>, websocket: WebSocketUpgrade) -> Response {
    if *state.shutdown.borrow() || state.shutdown.has_changed().is_err() {
        return (StatusCode::SERVICE_UNAVAILABLE, "Logging owner is stopping").into_response();
    }
    let Ok(permit) = state.slots.clone().try_acquire_owned() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Logging subscriber limit reached",
        )
            .into_response();
    };
    websocket
        .max_message_size(1024)
        .max_frame_size(1024)
        .write_buffer_size(4096)
        .max_write_buffer_size(16384)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(state, socket).await;
        })
}

async fn session(mut state: LoggingState, socket: WebSocket) {
    let follow = state.history.follow(None);
    let mut live = follow.live;
    // The official UI replays the newest records, as many as it always has.
    let skip = follow.replay.len().saturating_sub(LOG_REPLAY_CAPACITY);
    let (mut output, mut input) = socket.split();
    for record in follow.replay.into_iter().skip(skip) {
        if !send(
            &mut output,
            Message::Text(record.json.as_ref().into()),
            &mut state.shutdown,
        )
        .await
        {
            return;
        }
    }
    loop {
        tokio::select! {
            _=state.shutdown.changed()=>return,
            incoming=input.next()=>match incoming {
                Some(Ok(Message::Ping(bytes)))=>{
                    if !send(&mut output,Message::Pong(bytes),&mut state.shutdown).await {return;}
                }
                Some(Ok(Message::Pong(_)))=>{},
                _=>return,
            },
            record=live.recv()=>match record {
                Ok(record)=>if !send(&mut output,Message::Text(record.json.as_ref().into()),&mut state.shutdown).await {return;},
                Err(broadcast::error::RecvError::Lagged(_))=>{
                    let close=Message::Close(Some(CloseFrame {code:1013,reason:"Log history overrun; reconnect for retained history".into()}));
                    let _=send(&mut output,close,&mut state.shutdown).await;return;
                }
                Err(broadcast::error::RecvError::Closed)=>return,
            }
        }
    }
}

async fn send<S: Sink<Message> + Unpin>(
    output: &mut S,
    message: Message,
    shutdown: &mut watch::Receiver<bool>,
) -> bool {
    if *shutdown.borrow() {
        return false;
    }
    tokio::select! {
        _=shutdown.changed()=>false,
        result=tokio::time::timeout(SEND_DEADLINE,output.send(message))=>if let Ok(result)=result {
            result.is_ok()
        } else {
            eprintln!("firenook Logging diagnostics: client send exceeded 30 seconds; disconnecting");false
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::sync::oneshot;

    struct BlockedSink(Option<oneshot::Sender<()>>);
    impl Sink<Message> for BlockedSink {
        type Error = std::io::Error;
        fn poll_ready(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            if let Some(entered) = self.0.take() {
                let _ = entered.send(());
            }
            Poll::Pending
        }
        fn start_send(self: Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
            unreachable!("not ready")
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }
        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn logging_stalled_send_expires_at_manifest_deadline() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../benchmarks/phase-b-logging.json")).unwrap();
        assert_eq!(contract["sendDeadlineSeconds"], SEND_DEADLINE.as_secs());
        let (_owner, mut shutdown) = watch::channel(false);
        let began = tokio::time::Instant::now();
        assert!(
            !send(
                &mut BlockedSink(None),
                Message::Text("synthetic".into()),
                &mut shutdown
            )
            .await
        );
        assert_eq!(began.elapsed(), SEND_DEADLINE);
    }

    #[tokio::test(start_paused = true)]
    async fn logging_owner_loss_cancels_blocked_send_immediately() {
        let (owner, mut shutdown) = watch::channel(false);
        let (entered, ready) = oneshot::channel();
        let began = tokio::time::Instant::now();
        let task = tokio::spawn(async move {
            send(
                &mut BlockedSink(Some(entered)),
                Message::Text("synthetic".into()),
                &mut shutdown,
            )
            .await
        });
        ready.await.unwrap();
        drop(owner);
        assert!(!task.await.unwrap());
        assert!(began.elapsed() < SEND_DEADLINE);
    }
}
