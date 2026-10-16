//! Folders and selections downloaded as one `.zip`, streamed.
//!
//! A folder or a whole bucket downloads straight from a plain link. A
//! selection too long for a URL is posted first and becomes a ticket: at
//! most 100,000 objects or 20 GB (else refused with the counts), at most 16
//! live tickets, each served until one response has completed or ten
//! minutes have passed — so a browser's retry of a failed download works —
//! and refused while one response is streaming.
//!
//! The archive is written by `zip`'s streaming writer on the console's own
//! blocking tasks into a bounded channel (8 × 64 KB), so memory stays flat
//! whatever the size and a client that stops reading stops the writer.
//! Already-compressed types are stored, the rest deflated; an entry of 4 GiB
//! or more, and every gzip-encoded object (written decoded, so its size is
//! not known up front), uses zip64. Names are relative to the selection's
//! common folder. The writer ends when the service stops.

use std::collections::HashMap;
use std::io::{Read as _, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};

use crate::bulk::BulkSource;
use crate::console::{ConsoleError, StorageConsoleApi};
use crate::filter::StorageFilter;
use crate::listing::{FastScope, ListEntry, ListKind, fast_page, is_marker};
use crate::{StorageState, StoredObject, lock, object_key};

/// Objects one ticket holds at most.
pub const EXPORT_OBJECTS: u64 = 100_000;
/// Bytes one ticket holds at most.
pub const EXPORT_BYTES: u64 = 20 * 1024 * 1024 * 1024;
/// Tickets kept at once.
const TICKETS: usize = 16;
/// How long a ticket is served.
pub const TICKET_LIFE: Duration = Duration::from_mins(10);
/// One chunk of the stream.
const CHUNK: usize = 64 * 1024;
/// Chunks buffered between the writer and the response.
const BUFFERED: usize = 8;
/// Stored sizes from which an entry needs zip64.
const ZIP64_FROM: u64 = 4 * 1024 * 1024 * 1024;

/// A selection ready to download.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportTicketInfo {
    pub id: String,
    pub objects: u64,
    pub bytes: u64,
}

/// What a download streams.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExportSource {
    /// A posted selection.
    Ticket(String),
    /// Everything under a folder (`''` for the whole bucket).
    Folder { bucket: String, prefix: String },
}

/// One selection waiting for its download.
struct Ticket {
    bucket: String,
    names: Arc<[String]>,
    /// The common folder entries are named relative to.
    root: String,
    created: Instant,
    streaming: bool,
}

/// The live tickets.
#[derive(Default)]
pub(crate) struct ExportTickets {
    tickets: Mutex<HashMap<String, Ticket>>,
    next: std::sync::atomic::AtomicU64,
}

impl std::fmt::Debug for ExportTickets {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ExportTickets")
    }
}

/// The folder every name lies in (up to its last `/`), shared by all.
fn common_folder(names: &[String]) -> String {
    let Some(first) = names.first() else {
        return String::new();
    };
    let mut common = &first[..first.rfind('/').map_or(0, |slash| slash + 1)];
    for name in &names[1..] {
        while !name.starts_with(common) {
            let trimmed = common.strip_suffix('/').unwrap_or(common);
            common = &common[..trimmed.rfind('/').map_or(0, |slash| slash + 1)];
        }
    }
    common.to_owned()
}

/// The archive's file name for a folder (or the bucket) of `bucket`.
fn archive_name(bucket: &str, folder: &str) -> String {
    let segment = folder
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    let base = if segment.is_empty() { bucket } else { segment };
    format!("{base}.zip")
}

/// Whether a type is stored rather than deflated: deflating it gains nothing.
fn already_compressed(content_type: Option<&str>) -> bool {
    let Some(content_type) = content_type else {
        return false;
    };
    let media = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    media.starts_with("image/") && media != "image/svg+xml" && media != "image/bmp"
        || media.starts_with("video/")
        || media.starts_with("audio/") && media != "audio/wav"
        || matches!(
            media.as_str(),
            "application/zip"
                | "application/gzip"
                | "application/x-gzip"
                | "application/x-7z-compressed"
                | "application/x-bzip2"
                | "application/x-rar-compressed"
                | "application/vnd.rar"
                | "application/x-xz"
                | "application/zstd"
                | "application/pdf"
                | "application/epub+zip"
        )
}

/// A `Write` that hands 64 KB chunks to the response through a bounded
/// channel, failing once nobody reads or the service stops.
struct ChannelWriter {
    sender: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
    buffer: Vec<u8>,
    state: StorageState,
}

impl ChannelWriter {
    fn send(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let mut chunk = Some(Ok(Bytes::from(std::mem::replace(
            &mut self.buffer,
            Vec::with_capacity(CHUNK),
        ))));
        loop {
            if self.state.tasks.stopping() {
                return Err(std::io::Error::other("the service is stopping"));
            }
            match self.sender.try_send(chunk.take().expect("a chunk to send")) {
                Ok(()) => return Ok(()),
                Err(tokio::sync::mpsc::error::TrySendError::Full(back)) => {
                    chunk = Some(back);
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "the download was abandoned",
                    ));
                }
            }
        }
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() >= CHUNK {
            self.send()?;
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.send()
    }
}

/// Where the entries come from: a fixed list, or a folder read in chunks
/// as the archive is written.
enum Entries {
    Names(Arc<[String]>, usize),
    Folder {
        prefix: String,
        after: Option<String>,
        done: bool,
    },
}

impl Entries {
    /// The next objects to write, up to 256 at a time.
    fn next(&mut self, state: &StorageState, bucket: &str) -> Vec<StoredObject> {
        let data = lock(&state.inner);
        match self {
            Self::Names(names, position) => {
                let mut found = Vec::new();
                while *position < names.len() && found.len() < 256 {
                    if let Some(object) = data.objects.get(&object_key(bucket, &names[*position])) {
                        found.push(object.clone());
                    }
                    *position += 1;
                }
                found
            }
            Self::Folder {
                prefix,
                after,
                done,
            } => {
                if *done {
                    return Vec::new();
                }
                let scope = object_key(bucket, prefix);
                let start = after.as_ref().map(|name| object_key(bucket, name));
                let range = match &start {
                    Some(start) => data.objects.range::<str, _>((
                        std::ops::Bound::Excluded(start.as_str()),
                        std::ops::Bound::Unbounded,
                    )),
                    None => data.objects.range::<str, _>((
                        std::ops::Bound::Included(scope.as_str()),
                        std::ops::Bound::Unbounded,
                    )),
                };
                let mut found = Vec::new();
                for (key, object) in range {
                    if !key.starts_with(scope.as_str()) {
                        *done = true;
                        break;
                    }
                    *after = Some(object.name.clone());
                    if !is_marker(object) {
                        found.push(object.clone());
                    }
                    if found.len() >= 256 {
                        return found;
                    }
                }
                *done = true;
                found
            }
        }
    }
}

/// Writes the archive of `entries`; blocking, on the console's tasks.
fn write_archive(
    state: &StorageState,
    bucket: &str,
    root: &str,
    mut entries: Entries,
    writer: ChannelWriter,
) -> Result<(), String> {
    let mut zip = zip::ZipWriter::new_stream(writer);
    loop {
        let batch = entries.next(state, bucket);
        if batch.is_empty() {
            break;
        }
        for object in batch {
            if state.tasks.stopping() {
                return Err("the service is stopping".to_owned());
            }
            let gzip = object.content_encoding.as_deref() == Some("gzip");
            let method = if already_compressed(object.content_type.as_deref()) {
                zip::CompressionMethod::Stored
            } else {
                zip::CompressionMethod::Deflated
            };
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(method)
                .large_file(gzip || object.size >= ZIP64_FROM);
            let name = object.name.strip_prefix(root).unwrap_or(&object.name);
            let name = if name.is_empty() { "(unnamed)" } else { name };
            zip.start_file(name, options)
                .map_err(|error| error.to_string())?;
            let file = std::fs::File::open(state.config.data_dir.join(&object.data_file))
                .map_err(|error| error.to_string())?;
            let copied = if gzip {
                std::io::copy(&mut flate2::read::MultiGzDecoder::new(file), &mut zip)
            } else {
                std::io::copy(&mut file.take(object.size), &mut zip)
            };
            copied.map_err(|error| error.to_string())?;
        }
    }
    let mut writer = zip.finish().map_err(|error| error.to_string())?;
    writer.get_mut().flush().map_err(|error| error.to_string())
}

impl StorageConsoleApi {
    /// Resolves a selection to download as one `.zip` into a ticket, at
    /// most [`EXPORT_OBJECTS`] objects and [`EXPORT_BYTES`]. Blocking: call
    /// it off the request workers.
    pub fn export_ticket(
        &self,
        bucket: &str,
        source: &BulkSource,
    ) -> Result<ExportTicketInfo, ConsoleError> {
        let state = self.state_ref();
        let names = export_names(state, bucket, source)?;
        let (objects, bytes) = {
            let data = lock(&state.inner);
            names.iter().fold((0_u64, 0_u64), |(objects, bytes), name| {
                let size = data
                    .objects
                    .get(&object_key(bucket, name))
                    .map_or(0, |object| object.size);
                (objects + 1, bytes.saturating_add(size))
            })
        };
        if objects > EXPORT_OBJECTS || bytes > EXPORT_BYTES {
            return Err(ConsoleError::TooLarge(format!(
                "This selection is {objects} files and {}; one download holds at most {EXPORT_OBJECTS} files and 20 GB.",
                crate::staging::format_bytes(bytes)
            )));
        }
        if objects == 0 {
            return Err(ConsoleError::Invalid(
                "This selection holds no files.".to_owned(),
            ));
        }
        let root = common_folder(&names);
        let tickets = &state.exports;
        let mut live = lock(&tickets.tickets);
        live.retain(|_, ticket| ticket.created.elapsed() < TICKET_LIFE);
        while live.len() >= TICKETS {
            let Some(oldest) = live
                .iter()
                .filter(|(_, ticket)| !ticket.streaming)
                .min_by_key(|(_, ticket)| ticket.created)
                .map(|(id, _)| id.clone())
            else {
                return Err(ConsoleError::Conflict(
                    "Too many downloads are running at once; wait for one to finish.".to_owned(),
                ));
            };
            live.remove(&oldest);
        }
        let id = format!(
            "x{}{}",
            tickets
                .next
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                + 1,
            &crate::stable_id(&[bucket, &crate::now_millis().to_string()])[..10]
        );
        live.insert(
            id.clone(),
            Ticket {
                bucket: bucket.to_owned(),
                names: Arc::from(names),
                root,
                created: Instant::now(),
                streaming: false,
            },
        );
        Ok(ExportTicketInfo { id, objects, bytes })
    }

    /// The `.zip` of a ticket or a folder: its file name and the streamed
    /// body. A ticket is refused while another response streams it, and is
    /// used up once one response reaches its end with the whole archive
    /// written; a response dropped before that, or an archive that failed,
    /// leaves it usable for a retry.
    pub fn export_stream(&self, source: &ExportSource) -> Result<(String, Body), ConsoleError> {
        let state = self.state_ref().clone();
        let (bucket, root, entries, ticket) = match source {
            ExportSource::Ticket(id) => {
                let mut live = lock(&state.exports.tickets);
                live.retain(|_, ticket| ticket.created.elapsed() < TICKET_LIFE);
                let ticket = live.get_mut(id).ok_or_else(|| {
                    ConsoleError::NotFound(
                        "This download link has expired or was used; select the files again."
                            .to_owned(),
                    )
                })?;
                if ticket.streaming {
                    return Err(ConsoleError::Conflict(
                        "This download is already running in another request.".to_owned(),
                    ));
                }
                ticket.streaming = true;
                (
                    ticket.bucket.clone(),
                    ticket.root.clone(),
                    Entries::Names(Arc::clone(&ticket.names), 0),
                    Some(id.clone()),
                )
            }
            ExportSource::Folder { bucket, prefix } => {
                if !(prefix.is_empty() || prefix.ends_with('/')) {
                    return Err(ConsoleError::Invalid(
                        "prefix must be empty or end with `/`.".to_owned(),
                    ));
                }
                (
                    bucket.clone(),
                    prefix.clone(),
                    Entries::Folder {
                        prefix: prefix.clone(),
                        after: None,
                        done: false,
                    },
                    None,
                )
            }
        };
        let file_name = archive_name(&bucket, &root);
        let (sender, receiver) = tokio::sync::mpsc::channel(BUFFERED);
        let writer = ChannelWriter {
            sender: sender.clone(),
            buffer: Vec::with_capacity(CHUNK),
            state: state.clone(),
        };
        // The response holds the ticket, not the writer: a small archive is
        // written into the channel's buffer before anyone reads it, and the
        // ticket must stay taken until the response itself is done.
        let complete = Arc::new(AtomicBool::new(false));
        let release = ticket.map(|id| TicketRelease {
            state: state.clone(),
            id,
            complete: Arc::clone(&complete),
            settled: false,
        });
        let worker = state.clone();
        let started = state.tasks.spawn_blocking(move || {
            match write_archive(&worker, &bucket, &root, entries, writer) {
                Ok(()) => complete.store(true, Ordering::Release),
                Err(error) => {
                    let _ = sender.try_send(Err(std::io::Error::other(error)));
                }
            }
        });
        if !started {
            return Err(ConsoleError::Unavailable(
                "The service is stopping.".to_owned(),
            ));
        }
        let body = Body::from_stream(futures_util::stream::unfold(
            (receiver, release),
            |(mut receiver, mut release)| async move {
                let chunk = receiver.recv().await;
                if chunk.is_none()
                    && let Some(release) = release.as_mut()
                {
                    release.settle();
                }
                chunk.map(|chunk| (chunk, (receiver, release)))
            },
        ));
        Ok((file_name, body))
    }
}

/// A ticket taken by one response. The channel closes once the writer is
/// done: if the archive was written whole the ticket is used up, otherwise
/// (and when the response is dropped before its end) it is free again.
struct TicketRelease {
    state: StorageState,
    id: String,
    /// Set by the writer once the whole archive is in the channel.
    complete: Arc<AtomicBool>,
    settled: bool,
}

impl TicketRelease {
    /// The response reached its end.
    fn settle(&mut self) {
        self.settled = true;
        let mut live = lock(&self.state.exports.tickets);
        if self.complete.load(Ordering::Acquire) {
            live.remove(&self.id);
        } else if let Some(ticket) = live.get_mut(&self.id) {
            ticket.streaming = false;
        }
    }
}

impl Drop for TicketRelease {
    fn drop(&mut self) {
        if !self.settled
            && let Some(ticket) = lock(&self.state.exports.tickets).get_mut(&self.id)
        {
            ticket.streaming = false;
        }
    }
}

/// The names a selection resolves to (folders expanded, markers left out).
fn export_names(
    state: &StorageState,
    bucket: &str,
    source: &BulkSource,
) -> Result<Vec<String>, ConsoleError> {
    let mut names = Vec::new();
    let add_folder = |prefix: &str, names: &mut Vec<String>| -> Result<(), ConsoleError> {
        let scope = object_key(bucket, prefix);
        let data = lock(&state.inner);
        for (key, object) in data.objects.range::<str, _>((
            std::ops::Bound::Included(scope.as_str()),
            std::ops::Bound::Unbounded,
        )) {
            if !key.starts_with(scope.as_str()) {
                break;
            }
            if !is_marker(object) {
                names.push(object.name.clone());
                if names.len() as u64 > EXPORT_OBJECTS {
                    return Err(ConsoleError::TooLarge(format!(
                        "This selection is more than {EXPORT_OBJECTS} files; one download holds at most {EXPORT_OBJECTS}."
                    )));
                }
            }
        }
        Ok(())
    };
    match source {
        BulkSource::Keys(keys) => {
            for key in keys {
                if key.ends_with('/') {
                    add_folder(key, &mut names)?;
                } else if lock(&state.inner)
                    .objects
                    .contains_key(&object_key(bucket, key))
                {
                    names.push(key.clone());
                }
            }
        }
        BulkSource::Query {
            prefix,
            flat,
            filter,
        } => {
            for (folder, file) in query_entries(state, bucket, prefix, *flat, filter.as_ref()) {
                match (folder, file) {
                    (Some(folder), _) => add_folder(&folder, &mut names)?,
                    (None, Some(file)) => names.push(file),
                    (None, None) => {}
                }
            }
        }
    }
    names.sort_unstable();
    names.dedup();
    Ok(names)
}

/// The folders and files a listing matches, as `(folder, file)` pairs.
fn query_entries(
    state: &StorageState,
    bucket: &str,
    prefix: &str,
    flat: bool,
    filter: Option<&StorageFilter>,
) -> Vec<(Option<String>, Option<String>)> {
    let scope = FastScope {
        bucket,
        prefix,
        flat,
        kind: ListKind::All,
    };
    let mut found = Vec::new();
    let mut after = None;
    loop {
        let data = lock(&state.inner);
        let page = fast_page(&data, &scope, after.as_ref(), None, 10_000);
        for (entry, _) in &page.entries {
            match entry {
                ListEntry::Folder(folder) => {
                    if filter
                        .is_none_or(|filter| filter.matches_folder(&folder.prefix[prefix.len()..]))
                    {
                        found.push((Some(folder.prefix.clone()), None));
                    }
                }
                ListEntry::File(file) => {
                    let matches = filter.is_none_or(|filter| {
                        data.objects
                            .get(&object_key(bucket, &file.name))
                            .is_some_and(|object| {
                                filter.matches_object(&file.name[prefix.len()..], object)
                            })
                    });
                    if matches {
                        found.push((None, Some(file.name.clone())));
                    }
                }
            }
        }
        if !page.more_after {
            return found;
        }
        after = page.entries.last().map(|(_, cursor)| cursor.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_folders_and_names() {
        let names = |list: &[&str]| {
            list.iter()
                .map(|name| (*name).to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(common_folder(&names(&["a/b/c.png", "a/b/d/e.png"])), "a/b/");
        assert_eq!(common_folder(&names(&["a/b/c.png", "a/x.png"])), "a/");
        assert_eq!(common_folder(&names(&["a.png", "b/c.png"])), "");
        assert_eq!(archive_name("bucket", "users/u1/"), "u1.zip");
        assert_eq!(archive_name("bucket", ""), "bucket.zip");
        assert!(already_compressed(Some("image/png")));
        assert!(!already_compressed(Some("image/svg+xml")));
        assert!(!already_compressed(Some("text/csv")));
        assert!(already_compressed(Some("application/zip")));
    }
}
