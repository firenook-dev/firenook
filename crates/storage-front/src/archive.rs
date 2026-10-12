//! The entries of a `.zip` object, read from its central directory: no entry
//! is decompressed, so listing a 2 GB export reads a few kilobytes.

/// One entry of an archive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub compressed: u64,
    pub directory: bool,
}

/// The first entries of an archive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveListing {
    pub entries: Vec<ArchiveEntry>,
    /// Entries in the whole archive.
    pub total: u32,
    /// More entries than `entries` holds.
    pub truncated: bool,
}

/// The most entries one listing returns.
pub const ARCHIVE_ENTRIES: usize = 2_000;

/// Lists the first `limit` entries of the zip at `path`; the zip error when
/// it is not one or cannot be read. Blocking.
pub(crate) fn list(path: &std::path::Path, limit: usize) -> Result<ArchiveListing, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let total = archive.len();
    let limit = limit.clamp(1, ARCHIVE_ENTRIES);
    let mut entries = Vec::with_capacity(total.min(limit));
    for index in 0..total.min(limit) {
        let entry = archive
            .by_index_raw(index)
            .map_err(|error| error.to_string())?;
        entries.push(ArchiveEntry {
            name: entry.name().to_owned(),
            size: entry.size(),
            compressed: entry.compressed_size(),
            directory: entry.is_dir(),
        });
    }
    Ok(ArchiveListing {
        entries,
        total: u32::try_from(total).unwrap_or(u32::MAX),
        truncated: total > limit,
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;

    fn directory() -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "firenook-archive-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("directory");
        directory
    }

    #[test]
    fn lists_central_directory() {
        let directory = directory();
        let path = directory.join("export.zip");
        {
            let file = std::fs::File::create(&path).expect("create");
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.add_directory("data/", options).expect("directory");
            for index in 0..5 {
                writer
                    .start_file(format!("data/{index}.json"), options)
                    .expect("entry");
                writer.write_all(&[b'a'; 1000]).expect("bytes");
            }
            writer.finish().expect("finish");
        }
        let listing = list(&path, 3).expect("listing");
        assert_eq!(listing.total, 6);
        assert!(listing.truncated);
        assert_eq!(listing.entries.len(), 3);
        assert!(listing.entries[0].directory);
        assert_eq!(listing.entries[1].name, "data/0.json");
        assert_eq!(listing.entries[1].size, 1000);
        assert!(listing.entries[1].compressed < 1000, "deflated");
        let whole = list(&path, 2_000).expect("listing");
        assert!(!whole.truncated);
        // Not a zip, and a zip whose central directory is damaged.
        let text = directory.join("notes.txt");
        std::fs::write(&text, "hello").expect("write");
        assert!(list(&text, 10).is_err());
        let bytes = std::fs::read(&path).expect("read");
        let corrupt = directory.join("corrupt.zip");
        std::fs::write(&corrupt, &bytes[..bytes.len() - 30]).expect("write");
        assert!(list(&corrupt, 10).is_err());
        std::fs::remove_dir_all(directory).expect("cleanup");
    }
}
