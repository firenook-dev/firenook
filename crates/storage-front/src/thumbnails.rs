//! Small pictures of image objects, for the console's grid and inspector.
//!
//! A grid that loads every original moves and decodes full-size photos in
//! the browser; a 320-pixel JPEG is 20 to 60 times smaller. So the engine
//! decodes JPEG, PNG, GIF (first frame) and WebP with strict limits, at most
//! two at a time and on the console's own tasks, resizes to the asked width,
//! and keeps the result in a 64 MB cache keyed by generation, so a new
//! upload is a new picture and nothing else ever is. A picture with an
//! alpha channel stays PNG, so a transparent logo looks transparent.

use std::collections::HashMap;
use std::io::{Cursor, Read as _};
use std::path::Path;
use std::sync::{Arc, Mutex};

use image::{DynamicImage, ImageFormat, ImageReader, Limits};

/// Widths a thumbnail is made at.
pub const THUMBNAIL_WIDTHS: [u32; 3] = [160, 320, 640];
/// The largest source that is thumbnailed, in bytes (decoded for gzip).
pub const THUMBNAIL_SOURCE_BYTES: u64 = 40 * 1024 * 1024;
/// The largest source that is thumbnailed, in pixels.
pub const THUMBNAIL_SOURCE_PIXELS: u64 = 50_000_000;
/// Decodes at once.
pub(crate) const DECODES: usize = 2;
/// Bytes of thumbnails cached.
const CACHE_BYTES: usize = 64 * 1024 * 1024;
const JPEG_QUALITY: u8 = 72;

/// A thumbnail, encoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thumbnail {
    pub bytes: Arc<[u8]>,
    /// `image/jpeg` or `image/png`.
    pub content_type: &'static str,
}

/// Why there is no thumbnail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ThumbnailError {
    /// A type the engine does not decode (415).
    Unsupported(String),
    /// Over the source limits (413).
    TooLarge(String),
    /// The bytes did not decode (415).
    Unreadable(String),
}

/// Which decoder a content type or the bytes call for.
fn format_of(content_type: Option<&str>, head: &[u8]) -> Result<ImageFormat, ThumbnailError> {
    if let Ok(format) = image::guess_format(head) {
        return match format {
            ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP => {
                Ok(format)
            }
            other => Err(ThumbnailError::Unsupported(format!(
                "No thumbnail for {}; the browser previews what it can.",
                other.to_mime_type()
            ))),
        };
    }
    Err(ThumbnailError::Unsupported(format!(
        "No thumbnail for {}; the browser previews what it can.",
        content_type.unwrap_or("this type")
    )))
}

fn limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(12_000);
    limits.max_image_height = Some(12_000);
    limits.max_alloc = Some(256 * 1024 * 1024);
    limits
}

/// Reads the source's bytes for decoding: the file itself, or, gzip-encoded,
/// its decoded bytes up to the source limit.
enum Source {
    File(std::path::PathBuf),
    Memory(Vec<u8>),
}

fn too_large(size: u64) -> ThumbnailError {
    ThumbnailError::TooLarge(format!(
        "Too large to thumbnail ({}); open it to preview.",
        crate::staging::format_bytes(size)
    ))
}

fn unreadable(error: impl std::fmt::Display) -> ThumbnailError {
    ThumbnailError::Unreadable(format!("This image cannot be read: {error}."))
}

/// Decodes the image at `path` and encodes it `width` pixels wide (never
/// wider than it is). Blocking.
pub(crate) fn render(
    path: &Path,
    content_type: Option<&str>,
    gzip: bool,
    width: u32,
) -> Result<Thumbnail, ThumbnailError> {
    let source = if gzip {
        let file = std::fs::File::open(path).map_err(unreadable)?;
        let mut bytes = Vec::new();
        flate2::read::MultiGzDecoder::new(file)
            .take(THUMBNAIL_SOURCE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(unreadable)?;
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if size > THUMBNAIL_SOURCE_BYTES {
            return Err(too_large(size));
        }
        Source::Memory(bytes)
    } else {
        let size = std::fs::metadata(path).map_err(unreadable)?.len();
        if size > THUMBNAIL_SOURCE_BYTES {
            return Err(too_large(size));
        }
        Source::File(path.to_path_buf())
    };
    let head = match &source {
        Source::Memory(bytes) => bytes[..bytes.len().min(64)].to_vec(),
        Source::File(path) => {
            let mut head = Vec::with_capacity(64);
            std::fs::File::open(path)
                .and_then(|file| file.take(64).read_to_end(&mut head))
                .map_err(unreadable)?;
            head
        }
    };
    let format = format_of(content_type, &head)?;
    let (source_width, source_height) = dimensions(&source, format)?;
    let pixels = u64::from(source_width) * u64::from(source_height);
    if pixels > THUMBNAIL_SOURCE_PIXELS {
        return Err(ThumbnailError::TooLarge(format!(
            "Too large to thumbnail ({} MP); open it to preview.",
            pixels / 1_000_000
        )));
    }
    let image = decoded(&source, format)?;
    let width = width.min(image.width()).max(1);
    let height = u32::try_from(
        (u64::from(image.height()) * u64::from(width)).div_ceil(u64::from(image.width().max(1))),
    )
    .unwrap_or(u32::MAX)
    .max(1);
    let small = image.thumbnail(width, height);
    let mut bytes = Vec::new();
    let content_type = if small.color().has_alpha() {
        small
            .write_with_encoder(image::codecs::png::PngEncoder::new(&mut bytes))
            .map_err(unreadable)?;
        "image/png"
    } else {
        DynamicImage::ImageRgb8(small.to_rgb8())
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut bytes,
                JPEG_QUALITY,
            ))
            .map_err(unreadable)?;
        "image/jpeg"
    };
    Ok(Thumbnail {
        bytes: Arc::from(bytes),
        content_type,
    })
}

fn limited<R: std::io::BufRead + std::io::Seek>(
    mut reader: ImageReader<R>,
    format: ImageFormat,
) -> ImageReader<R> {
    reader.set_format(format);
    reader.limits(limits());
    reader
}

/// The source's width and height, read from its header within the limits.
fn dimensions(source: &Source, format: ImageFormat) -> Result<(u32, u32), ThumbnailError> {
    match source {
        Source::Memory(bytes) => {
            limited(ImageReader::new(Cursor::new(bytes.as_slice())), format).into_dimensions()
        }
        Source::File(path) => {
            limited(ImageReader::open(path).map_err(unreadable)?, format).into_dimensions()
        }
    }
    .map_err(|error| limit_or_unreadable(&error))
}

/// The source decoded, within the limits.
fn decoded(source: &Source, format: ImageFormat) -> Result<DynamicImage, ThumbnailError> {
    match source {
        Source::Memory(bytes) => {
            limited(ImageReader::new(Cursor::new(bytes.as_slice())), format).decode()
        }
        Source::File(path) => {
            limited(ImageReader::open(path).map_err(unreadable)?, format).decode()
        }
    }
    .map_err(|error| limit_or_unreadable(&error))
}

fn limit_or_unreadable(error: &image::ImageError) -> ThumbnailError {
    match error {
        image::ImageError::Limits(_) => ThumbnailError::TooLarge(
            "Too large to thumbnail (over 12,000 pixels a side); open it to preview.".to_owned(),
        ),
        other => unreadable(other),
    }
}

/// Thumbnails already made, by object generation and width.
pub(crate) struct ThumbnailCache {
    state: Mutex<CacheState>,
    /// At most [`DECODES`] decodes at once.
    pub(crate) decodes: tokio::sync::Semaphore,
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<(String, String, u64, u32), (Thumbnail, u64)>,
    bytes: usize,
    tick: u64,
}

impl std::fmt::Debug for ThumbnailCache {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ThumbnailCache")
    }
}

impl ThumbnailCache {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::default(),
            decodes: tokio::sync::Semaphore::new(DECODES),
        }
    }

    pub(crate) fn get(
        &self,
        bucket: &str,
        name: &str,
        generation: u64,
        width: u32,
    ) -> Option<Thumbnail> {
        let mut state = crate::lock(&self.state);
        state.tick += 1;
        let tick = state.tick;
        let entry =
            state
                .entries
                .get_mut(&(bucket.to_owned(), name.to_owned(), generation, width))?;
        entry.1 = tick;
        Some(entry.0.clone())
    }

    pub(crate) fn insert(
        &self,
        bucket: &str,
        name: &str,
        generation: u64,
        width: u32,
        thumbnail: Thumbnail,
    ) {
        let mut state = crate::lock(&self.state);
        state.tick += 1;
        let tick = state.tick;
        let size = thumbnail.bytes.len() + name.len() + bucket.len() + 64;
        if size > CACHE_BYTES {
            return;
        }
        if let Some((previous, _)) = state.entries.insert(
            (bucket.to_owned(), name.to_owned(), generation, width),
            (thumbnail, tick),
        ) {
            state.bytes -= previous.bytes.len() + name.len() + bucket.len() + 64;
        }
        state.bytes += size;
        while state.bytes > CACHE_BYTES {
            let Some(oldest) = state
                .entries
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some((evicted, _)) = state.entries.remove(&oldest) {
                state.bytes -= evicted.bytes.len() + oldest.1.len() + oldest.0.len() + 64;
            }
        }
    }

    /// Entries held, for tests.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        crate::lock(&self.state).entries.len()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use image::{ImageEncoder as _, Rgba, RgbaImage};

    use super::*;

    fn directory() -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "firenook-thumbnails-{}-{}",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("directory");
        directory
    }

    fn png(width: u32, height: u32, alpha: u8) -> Vec<u8> {
        let image = RgbaImage::from_pixel(width, height, Rgba([200, 30, 30, alpha]));
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(
                image.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )
            .expect("png");
        bytes
    }

    fn encoded(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).expect("encode");
        bytes.into_inner()
    }

    #[test]
    fn formats_limits_cache() {
        let directory = directory();
        let opaque = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            1200,
            800,
            image::Rgb([10, 120, 200]),
        ));
        for (format, name) in [
            (ImageFormat::Jpeg, "photo.jpg"),
            (ImageFormat::Png, "photo.png"),
            (ImageFormat::Gif, "photo.gif"),
            (ImageFormat::WebP, "photo.webp"),
        ] {
            let path = directory.join(name);
            let source = if format == ImageFormat::Gif {
                DynamicImage::ImageRgba8(opaque.to_rgba8())
            } else {
                opaque.clone()
            };
            std::fs::write(&path, encoded(&source, format)).expect("write");
            let thumbnail =
                render(&path, None, false, 320).unwrap_or_else(|error| panic!("{name}: {error:?}"));
            let decoded = image::load_from_memory(&thumbnail.bytes).expect("decodes");
            assert!(decoded.width() <= 320, "{name}");
            assert_eq!(decoded.width(), 320, "{name}");
            assert!(
                (213..=214).contains(&decoded.height()),
                "{name} keeps its aspect"
            );
        }
        // An alpha channel stays PNG; an opaque source becomes JPEG.
        let logo = directory.join("logo.png");
        std::fs::write(&logo, png(400, 400, 100)).expect("write");
        assert_eq!(
            render(&logo, None, false, 160).expect("logo").content_type,
            "image/png"
        );
        let photo = directory.join("photo.png");
        assert_eq!(
            render(&photo, None, false, 160)
                .expect("photo")
                .content_type,
            "image/jpeg"
        );
        // Never wider than the source.
        let small = directory.join("small.png");
        std::fs::write(&small, png(40, 20, 255)).expect("write");
        let thumbnail = render(&small, None, false, 640).expect("small");
        assert_eq!(
            image::load_from_memory(&thumbnail.bytes)
                .expect("decode")
                .width(),
            40
        );
        // Unsupported types and unreadable bytes.
        let svg = directory.join("icon.svg");
        std::fs::write(&svg, "<svg xmlns='http://www.w3.org/2000/svg'/>").expect("write");
        assert!(matches!(
            render(&svg, Some("image/svg+xml"), false, 160),
            Err(ThumbnailError::Unsupported(message)) if message.contains("image/svg+xml")
        ));
        let heic = directory.join("photo.heic");
        std::fs::write(&heic, b"\0\0\0\x18ftypheic\0\0\0\0").expect("write");
        assert!(matches!(
            render(&heic, Some("image/heic"), false, 160),
            Err(ThumbnailError::Unsupported(_))
        ));
        // A gzip-encoded PNG thumbnails through its decoded bytes (an RGBA
        // source keeps its alpha channel).
        let gzipped = directory.join("logo.png.gz");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&png(300, 300, 255)).expect("gzip");
        std::fs::write(&gzipped, encoder.finish().expect("finish")).expect("write");
        assert_eq!(
            render(&gzipped, Some("image/png"), true, 160)
                .expect("gzip")
                .content_type,
            "image/png"
        );
        std::fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn sixty_megapixels_is_too_large() {
        let directory = directory();
        // A tiny file whose header claims 8,000 × 7,500 pixels.
        let path = directory.join("huge.png");
        let mut header = png(1, 1, 255);
        // IHDR width and height sit at bytes 16..24 of a PNG.
        header[16..20].copy_from_slice(&8_000_u32.to_be_bytes());
        header[20..24].copy_from_slice(&7_500_u32.to_be_bytes());
        // The chunk's checksum covers its type and data.
        let mut crc = flate2::Crc::new();
        crc.update(&header[12..29]);
        header[29..33].copy_from_slice(&crc.sum().to_be_bytes());
        std::fs::write(&path, header).expect("write");
        assert!(matches!(
            render(&path, Some("image/png"), false, 320),
            Err(ThumbnailError::TooLarge(message)) if message.contains("60 MP")
        ));
        std::fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn the_cache_hits_by_generation_and_evicts() {
        let cache = ThumbnailCache::new();
        let thumbnail = Thumbnail {
            bytes: Arc::from(vec![1_u8; 1024]),
            content_type: "image/jpeg",
        };
        cache.insert("b", "a.png", 1, 320, thumbnail.clone());
        assert_eq!(cache.get("b", "a.png", 1, 320), Some(thumbnail));
        assert_eq!(
            cache.get("b", "a.png", 2, 320),
            None,
            "a new generation misses"
        );
        assert_eq!(cache.get("b", "a.png", 1, 160), None);
        let big = Thumbnail {
            bytes: Arc::from(vec![0_u8; 20 * 1024 * 1024]),
            content_type: "image/png",
        };
        for generation in 0..4 {
            cache.insert("b", "big.png", generation, 640, big.clone());
        }
        assert!(cache.len() <= 4, "64 MB holds three of them");
        assert_eq!(
            cache.get("b", "big.png", 0, 640),
            None,
            "the oldest went first"
        );
    }
}
