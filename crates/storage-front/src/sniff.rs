//! What an object's first bytes say it is.
//!
//! The console warns when an object's contentType disagrees with its bytes
//! (the commonest reason a file downloads instead of displaying), so it
//! needs the bytes' own word: a magic number when there is one, or "text"
//! when they read as UTF-8 without NUL bytes. Only the first 512 bytes are
//! read, decoded first for a gzip-encoded object.

use std::io::Read as _;

/// How many leading bytes are read.
pub(crate) const SNIFF_BYTES: usize = 512;

/// The family a signature belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SniffFamily {
    Image,
    Video,
    Audio,
    Pdf,
    Archive,
    Text,
    Binary,
}

/// What the first bytes are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sniffed {
    /// `image/png`, `application/zip`, `text/plain`, …
    pub mime: &'static str,
    pub family: SniffFamily,
    /// A magic number matched (not only "valid UTF-8").
    pub definite: bool,
}

const fn definite(mime: &'static str, family: SniffFamily) -> Sniffed {
    Sniffed {
        mime,
        family,
        definite: true,
    }
}

/// The signature of `bytes` (an object's first bytes, decoded).
pub(crate) fn sniff(bytes: &[u8]) -> Option<Sniffed> {
    let starts = |magic: &[u8]| bytes.starts_with(magic);
    let at = |offset: usize, magic: &[u8]| bytes.get(offset..offset + magic.len()) == Some(magic);
    if starts(b"\x89PNG\r\n\x1a\n") {
        return Some(definite("image/png", SniffFamily::Image));
    }
    if starts(b"\xFF\xD8\xFF") {
        return Some(definite("image/jpeg", SniffFamily::Image));
    }
    if starts(b"GIF87a") || starts(b"GIF89a") {
        return Some(definite("image/gif", SniffFamily::Image));
    }
    if starts(b"RIFF") && at(8, b"WEBP") {
        return Some(definite("image/webp", SniffFamily::Image));
    }
    if starts(b"RIFF") && at(8, b"WAVE") {
        return Some(definite("audio/wav", SniffFamily::Audio));
    }
    if at(4, b"ftyp") {
        let brand = bytes.get(8..12).unwrap_or_default();
        return match brand {
            b"avif" | b"avis" => Some(definite("image/avif", SniffFamily::Image)),
            b"heic" | b"heix" | b"hevc" | b"heim" | b"heis" | b"mif1" | b"msf1" => {
                Some(definite("image/heic", SniffFamily::Image))
            }
            b"qt  " => Some(definite("video/quicktime", SniffFamily::Video)),
            b"M4A " | b"M4B " => Some(definite("audio/mp4", SniffFamily::Audio)),
            _ => Some(definite("video/mp4", SniffFamily::Video)),
        };
    }
    if starts(b"\x1A\x45\xDF\xA3") {
        let webm = bytes
            .windows(4)
            .take(SNIFF_BYTES)
            .any(|window| window == b"webm");
        return Some(if webm {
            definite("video/webm", SniffFamily::Video)
        } else {
            definite("video/x-matroska", SniffFamily::Video)
        });
    }
    if starts(b"ID3") || (bytes.len() > 1 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0) {
        return Some(definite("audio/mpeg", SniffFamily::Audio));
    }
    if starts(b"OggS") {
        return Some(definite("audio/ogg", SniffFamily::Audio));
    }
    if starts(b"fLaC") {
        return Some(definite("audio/flac", SniffFamily::Audio));
    }
    if starts(b"%PDF-") {
        return Some(definite("application/pdf", SniffFamily::Pdf));
    }
    if starts(b"PK\x03\x04") || starts(b"PK\x05\x06") || starts(b"PK\x07\x08") {
        // Zip containers (.docx, .xlsx, .apk, .jar, .epub) are zips.
        return Some(definite("application/zip", SniffFamily::Archive));
    }
    if starts(b"\x1F\x8B") {
        return Some(definite("application/gzip", SniffFamily::Archive));
    }
    if starts(b"BZh") {
        return Some(definite("application/x-bzip2", SniffFamily::Archive));
    }
    if starts(b"7z\xBC\xAF\x27\x1C") {
        return Some(definite(
            "application/x-7z-compressed",
            SniffFamily::Archive,
        ));
    }
    if starts(b"SQLite format 3\0") {
        return Some(definite("application/vnd.sqlite3", SniffFamily::Binary));
    }
    if starts(b"\x7FELF") {
        return Some(definite("application/x-elf", SniffFamily::Binary));
    }
    if starts(b"\xCF\xFA\xED\xFE")
        || starts(b"\xCE\xFA\xED\xFE")
        || starts(b"\xFE\xED\xFA\xCF")
        || starts(b"\xFE\xED\xFA\xCE")
    {
        return Some(definite("application/x-mach-binary", SniffFamily::Binary));
    }
    if starts(b"\0asm") {
        return Some(definite("application/wasm", SniffFamily::Binary));
    }
    if !bytes.is_empty() && !bytes.contains(&0) && utf8_prefix(bytes) {
        return Some(Sniffed {
            mime: "text/plain",
            family: SniffFamily::Text,
            definite: false,
        });
    }
    None
}

/// Whether `bytes` is valid UTF-8, allowing a character cut off at the end
/// (the read stops at a fixed length).
fn utf8_prefix(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none() && bytes.len() - error.valid_up_to() < 4,
    }
}

/// Reads the first [`SNIFF_BYTES`] of the file at `path`, decoded when
/// `gzip`, and sniffs them. Blocking.
pub(crate) fn sniff_file(path: &std::path::Path, gzip: bool) -> Option<Sniffed> {
    let file = std::fs::File::open(path).ok()?;
    let mut buffer = Vec::with_capacity(SNIFF_BYTES);
    let limit = u64::try_from(SNIFF_BYTES).unwrap_or(u64::MAX);
    let read = if gzip {
        flate2::read::MultiGzDecoder::new(file)
            .take(limit)
            .read_to_end(&mut buffer)
    } else {
        file.take(limit).read_to_end(&mut buffer)
    };
    // A gzip stream that ends early still has its first bytes.
    if read.is_err() && buffer.is_empty() {
        return None;
    }
    sniff(&buffer)
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;

    #[test]
    fn signatures() {
        let cases: &[(&[u8], &str, SniffFamily)] = &[
            (b"\x89PNG\r\n\x1a\n....", "image/png", SniffFamily::Image),
            (b"\xFF\xD8\xFF\xE0", "image/jpeg", SniffFamily::Image),
            (b"GIF89a....", "image/gif", SniffFamily::Image),
            (b"RIFF\0\0\0\0WEBPVP8 ", "image/webp", SniffFamily::Image),
            (b"\0\0\0\x1cftypavif", "image/avif", SniffFamily::Image),
            (b"\0\0\0\x1cftypheic", "image/heic", SniffFamily::Image),
            (b"\0\0\0\x18ftypisom", "video/mp4", SniffFamily::Video),
            (b"\0\0\0\x14ftypqt  ", "video/quicktime", SniffFamily::Video),
            (
                b"\x1A\x45\xDF\xA3\x9f\x42\x82\x84webm",
                "video/webm",
                SniffFamily::Video,
            ),
            (
                b"\x1A\x45\xDF\xA3\x9f\x42\x82\x88matroska",
                "video/x-matroska",
                SniffFamily::Video,
            ),
            (b"RIFF\0\0\0\0WAVEfmt ", "audio/wav", SniffFamily::Audio),
            (b"ID3\x04\0", "audio/mpeg", SniffFamily::Audio),
            (b"OggS\0", "audio/ogg", SniffFamily::Audio),
            (b"fLaC\0", "audio/flac", SniffFamily::Audio),
            (b"%PDF-1.7", "application/pdf", SniffFamily::Pdf),
            (b"PK\x03\x04\x14\0", "application/zip", SniffFamily::Archive),
            (b"\x1F\x8B\x08\0", "application/gzip", SniffFamily::Archive),
            (b"BZh91AY", "application/x-bzip2", SniffFamily::Archive),
            (
                b"7z\xBC\xAF\x27\x1C\0",
                "application/x-7z-compressed",
                SniffFamily::Archive,
            ),
            (
                b"SQLite format 3\0",
                "application/vnd.sqlite3",
                SniffFamily::Binary,
            ),
            (b"\x7FELF\x02", "application/x-elf", SniffFamily::Binary),
            (
                b"\xCF\xFA\xED\xFE",
                "application/x-mach-binary",
                SniffFamily::Binary,
            ),
            (b"\0asm\x01\0\0\0", "application/wasm", SniffFamily::Binary),
        ];
        for (bytes, mime, family) in cases {
            let sniffed = sniff(bytes).unwrap_or_else(|| panic!("{mime}"));
            assert_eq!(sniffed.mime, *mime);
            assert_eq!(sniffed.family, *family, "{mime}");
            assert!(sniffed.definite, "{mime}");
        }
        let text = sniff("{\"été\": 1}".as_bytes()).expect("text");
        assert_eq!(text.mime, "text/plain");
        assert_eq!(text.family, SniffFamily::Text);
        assert!(!text.definite);
        // A multi-byte character cut by the read limit is still text.
        assert_eq!(
            sniff(&"é".as_bytes()[..1]).map(|s| s.family),
            Some(SniffFamily::Text)
        );
        assert_eq!(sniff(b"text\0with a NUL"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn gzip_is_sniffed_decoded() {
        let directory = std::env::temp_dir().join(format!(
            "firenook-sniff-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("directory");
        let path = directory.join("logo.png.gz");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(b"\x89PNG\r\n\x1a\nrest of the image")
            .expect("encode");
        std::fs::write(&path, encoder.finish().expect("finish")).expect("write");
        assert_eq!(
            sniff_file(&path, true).map(|sniffed| sniffed.mime),
            Some("image/png")
        );
        assert_eq!(
            sniff_file(&path, false).map(|sniffed| sniffed.mime),
            Some("application/gzip")
        );
        std::fs::remove_dir_all(directory).expect("cleanup");
    }
}
