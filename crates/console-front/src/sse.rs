//! The suite's stop signal, and the one response every console stream sends.
//!
//! A listener's graceful drain waits for the connections it holds, so a
//! stream that outlived the stop signal would hold the whole suite open for
//! as long as a console tab was. [`Shutdown`] is the signal as a type that
//! cannot mean "never" (a dropped sender counts as stopped), and
//! [`sse_response`] ends every stream on it.

use std::convert::Infallible;
use std::time::Duration;

use axum::http::{HeaderName, HeaderValue};
use axum::response::IntoResponse;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::{Stream, StreamExt as _};
use serde::Serialize;
use tokio::sync::watch;

/// How often an idle stream says it is still there.
pub(crate) const KEEPALIVE: Duration = Duration::from_secs(15);

/// How long a stream may still write after the stop signal, so its own last
/// word (the live channel's `stopping`) reaches the browser before the body
/// ends. The suite's drain closes whatever is left after its own grace.
const FAREWELL: Duration = Duration::from_millis(250);

/// The suite's stop signal, as everything the console holds open consumes it.
#[derive(Clone, Debug)]
pub struct Shutdown {
    receiver: watch::Receiver<bool>,
}

impl Shutdown {
    /// The signal `receiver` carries: `true`, or its sender gone, is a stop.
    #[must_use]
    pub const fn new(receiver: watch::Receiver<bool>) -> Self {
        Self { receiver }
    }

    /// True once the suite is stopping or its sender is gone.
    #[must_use]
    pub fn is_stopping(&self) -> bool {
        *self.receiver.borrow() || self.receiver.has_changed().is_err()
    }

    /// Resolves when the suite stops; a dropped sender counts as stopped.
    pub async fn stopped(mut self) {
        while !*self.receiver.borrow() && self.receiver.changed().await.is_ok() {}
    }
}

/// The response every console stream sends: `text/event-stream` that ends
/// when the suite stops, a `: keep-alive` comment every 15 s, and
/// `x-accel-buffering: no` so a reverse proxy passes each event on at once.
pub(crate) fn sse_response<S>(events: S, shutdown: Shutdown) -> impl IntoResponse
where
    S: Stream<Item = Event> + Send + 'static,
{
    let ended = async move {
        shutdown.stopped().await;
        tokio::time::sleep(FAREWELL).await;
    };
    (
        [(
            HeaderName::from_static("x-accel-buffering"),
            HeaderValue::from_static("no"),
        )],
        Sse::new(events.map(Ok::<_, Infallible>).take_until(ended))
            .keep_alive(KeepAlive::new().interval(KEEPALIVE).text("keep-alive")),
    )
}

/// A named event with a JSON body. Serialization of the console's own types
/// cannot fail; an impossible failure sends the name alone.
pub(crate) fn json_event(name: &str, data: &impl Serialize) -> Event {
    Event::default()
        .event(name)
        .json_data(data)
        .unwrap_or_else(|_| Event::default().event(name))
}

#[cfg(test)]
mod tests {
    use axum::http::header;
    use futures_util::stream;

    use super::*;

    #[tokio::test]
    async fn stopped_resolves_on_the_signal_and_on_a_dropped_sender() {
        let (stop, receiver) = watch::channel(false);
        let shutdown = Shutdown::new(receiver);
        assert!(!shutdown.is_stopping());
        let waiting = tokio::spawn(shutdown.clone().stopped());
        stop.send(true).expect("a receiver");
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("resolved")
            .expect("joined");
        assert!(shutdown.is_stopping());

        let (stop, receiver) = watch::channel(false);
        let shutdown = Shutdown::new(receiver);
        drop(stop);
        assert!(shutdown.is_stopping());
        tokio::time::timeout(Duration::from_secs(5), shutdown.stopped())
            .await
            .expect("a dropped sender counts as stopped");
    }

    #[tokio::test]
    async fn a_stream_ends_when_the_suite_stops_and_tells_proxies_not_to_buffer() {
        let (stop, receiver) = watch::channel(false);
        let events = stream::once(async { json_event("hello", &serde_json::json!({})) })
            .chain(stream::pending());
        let response = sse_response(events, Shutdown::new(receiver)).into_response();
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/event-stream"
        );
        assert_eq!(response.headers()["x-accel-buffering"], "no");
        let mut body = response.into_body().into_data_stream();
        let first = tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("the first event arrives")
            .expect("a chunk")
            .expect("bytes");
        assert!(String::from_utf8_lossy(&first).contains("event: hello"));
        stop.send(true).expect("a receiver");
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(chunk) = body.next().await {
                chunk.expect("bytes");
            }
        })
        .await
        .expect("the body ended after the stop");
    }
}
