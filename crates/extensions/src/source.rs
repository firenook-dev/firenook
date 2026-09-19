//! Extension source directories: the firebase-tools cache
//! (`~/.cache/firebase/extensions/<publisher>/<name>@<version>`, or
//! `FIREBASE_EXTENSIONS_CACHE_PATH`), a project's vendored copies
//! (`<project>/extensions/.sources/...`), archive download and the
//! `npm install` / `npm run gcp-build` the official emulator runs once.
use std::io::Read as _;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::ExtensionsError;
use crate::refs::ExtensionRef;
use firenook_functions_runtime::LogSink;

/// The sidecar Firenook writes next to a downloaded or vendored source so
/// later starts need neither the registry nor a token.
pub const REGISTRY_SIDECAR: &str = "firenook-registry.json";
/// Vendored sources live under the project's `extensions/` parameter directory.
pub const VENDOR_DIRECTORY: &str = ".sources";
/// Maps an unresolved ref (as written in `firebase.json`) to the vendored version.
pub const VENDOR_MANIFEST: &str = "manifest.json";
const REQUIRED_FILES: [&str; 2] = ["extension.yaml", "functions/package.json"];

/// `FIREBASE_EXTENSIONS_CACHE_PATH` or `~/.cache/firebase/extensions`.
#[must_use]
pub fn cache_directory() -> PathBuf {
    if let Some(path) =
        std::env::var_os("FIREBASE_EXTENSIONS_CACHE_PATH").filter(|value| !value.is_empty())
    {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map_or_else(|| PathBuf::from("."), PathBuf::from);
    home.join(".cache").join("firebase").join("extensions")
}

/// `<project>/extensions/.sources`.
#[must_use]
pub fn vendor_directory(project_dir: &Path) -> PathBuf {
    project_dir
        .join(crate::params::ENV_DIRECTORY)
        .join(VENDOR_DIRECTORY)
}

/// The vendored version for a ref written in `firebase.json`, if recorded.
#[must_use]
pub fn vendored_version(project_dir: &Path, written_ref: &str) -> Option<String> {
    let manifest = vendor_directory(project_dir).join(VENDOR_MANIFEST);
    let text = std::fs::read_to_string(manifest).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    parsed.get(written_ref)?.as_str().map(str::to_owned)
}

/// Records the vendored version for a ref written in `firebase.json`.
pub fn record_vendored_version(
    project_dir: &Path,
    written_ref: &str,
    version: &str,
) -> Result<(), ExtensionsError> {
    let directory = vendor_directory(project_dir);
    std::fs::create_dir_all(&directory).map_err(|error| {
        ExtensionsError(format!("failed to create {}: {error}", directory.display()))
    })?;
    let manifest = directory.join(VENDOR_MANIFEST);
    let mut parsed: Value = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    if let Some(map) = parsed.as_object_mut() {
        map.insert(written_ref.to_owned(), Value::String(version.to_owned()));
    }
    let text = serde_json::to_string_pretty(&parsed)
        .map_err(|error| ExtensionsError(error.to_string()))?;
    std::fs::write(&manifest, format!("{text}\n")).map_err(|error| {
        ExtensionsError(format!("failed to write {}: {error}", manifest.display()))
    })
}

/// `hasValidSource`: the directory exists with `extension.yaml` and
/// `functions/package.json`.
#[must_use]
pub fn has_valid_source(directory: &Path) -> bool {
    directory.is_dir()
        && REQUIRED_FILES
            .iter()
            .all(|file| directory.join(file).is_file())
}

/// The registry objects stored next to a source.
#[derive(Debug, Clone)]
pub struct RegistrySidecar {
    pub extension: Value,
    pub extension_version: Value,
}

/// Reads the sidecar if present.
#[must_use]
pub fn read_sidecar(directory: &Path) -> Option<RegistrySidecar> {
    let text = std::fs::read_to_string(directory.join(REGISTRY_SIDECAR)).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    Some(RegistrySidecar {
        extension: parsed.get("extension")?.clone(),
        extension_version: parsed.get("extensionVersion")?.clone(),
    })
}

/// Writes the sidecar.
pub fn write_sidecar(directory: &Path, sidecar: &RegistrySidecar) -> Result<(), ExtensionsError> {
    let text = serde_json::to_string_pretty(&serde_json::json!({
        "extension": sidecar.extension,
        "extensionVersion": sidecar.extension_version,
    }))
    .map_err(|error| ExtensionsError(error.to_string()))?;
    let path = directory.join(REGISTRY_SIDECAR);
    std::fs::write(&path, format!("{text}\n"))
        .map_err(|error| ExtensionsError(format!("failed to write {}: {error}", path.display())))
}

/// The `<publisher>/<name>@<version>` path a source occupies under a root.
pub fn source_path(root: &Path, reference: &ExtensionRef) -> Result<PathBuf, ExtensionsError> {
    let version = reference
        .version
        .as_deref()
        .ok_or_else(|| ExtensionsError("Ref does not have a version".to_owned()))?;
    Ok(root
        .join(&reference.publisher_id)
        .join(format!("{}@{version}", reference.extension_id)))
}

/// Downloads the archive at `uri` and extracts it into `target`
/// (`downloadExtensionVersion`), then installs and builds the functions.
pub async fn download_source(
    uri: &str,
    reference: &ExtensionRef,
    target: &Path,
    npm: &Path,
    log: &LogSink,
) -> Result<(), ExtensionsError> {
    let version_ref = reference.version_ref()?;
    log.record(firenook_functions_runtime::LogEvent::new(
        "INFO",
        "extensions",
        format!(
            "Starting download for {version_ref} source code to {}..",
            target.display()
        ),
    ));
    std::fs::create_dir_all(target).map_err(|error| {
        ExtensionsError(format!("failed to create {}: {error}", target.display()))
    })?;
    log.record(firenook_functions_runtime::LogEvent::new(
        "INFO",
        "extensions",
        format!("downloading {uri}..."),
    ));
    let response = reqwest::get(uri)
        .await
        .map_err(|error| ExtensionsError(format!("failed to download {uri}: {error}")))?;
    if !response.status().is_success() {
        return Err(ExtensionsError(format!(
            "failed to download {uri}: HTTP {}",
            response.status().as_u16()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ExtensionsError(format!("failed to read {uri}: {error}")))?;
    let target_owned = target.to_path_buf();
    tokio::task::spawn_blocking(move || extract_zip(&bytes, &target_owned))
        .await
        .map_err(|error| ExtensionsError(format!("archive extraction failed: {error}")))??;
    log.record(firenook_functions_runtime::LogEvent::new(
        "INFO",
        "extensions",
        format!("Downloaded to {}...", target.display()),
    ));
    install_and_build(target, npm, log).await
}

fn extract_zip(bytes: &[u8], target: &Path) -> Result<(), ExtensionsError> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| ExtensionsError(format!("invalid extension archive: {error}")))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            ExtensionsError(format!("invalid extension archive entry: {error}"))
        })?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(ExtensionsError(format!(
                "ZIP contained an entry for {}, a path outside of {}",
                entry.name(),
                target.display()
            )));
        };
        let output = target.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output).map_err(|error| {
                ExtensionsError(format!("failed to create {}: {error}", output.display()))
            })?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                ExtensionsError(format!("failed to create {}: {error}", parent.display()))
            })?;
        }
        let mut contents = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or(0));
        entry.read_to_end(&mut contents).map_err(|error| {
            ExtensionsError(format!("failed to extract {}: {error}", output.display()))
        })?;
        std::fs::write(&output, contents).map_err(|error| {
            ExtensionsError(format!("failed to write {}: {error}", output.display()))
        })?;
    }
    Ok(())
}

/// `installAndBuildSourceCode`: `npm install` then `npm run gcp-build` in
/// `functions/`, each failure reported with the command's output.
pub async fn install_and_build(
    source: &Path,
    npm: &Path,
    log: &LogSink,
) -> Result<(), ExtensionsError> {
    let functions = source.join("functions");
    for arguments in [vec!["install"], vec!["run", "gcp-build"]] {
        log.record(firenook_functions_runtime::LogEvent::new(
            "DEBUG",
            "Extensions",
            format!(
                "Running \"npm {}\" for {}",
                arguments.join(" "),
                source.display()
            ),
        ));
        let mut command = tokio::process::Command::new(npm);
        command.args(&arguments).current_dir(&functions);
        // The npm script resolves `node` through PATH; put its own toolchain first.
        if let Some(bin) = npm.parent() {
            let mut path = std::ffi::OsString::from(bin);
            if let Some(existing) = std::env::var_os("PATH") {
                path.push(":");
                path.push(existing);
            }
            command.env("PATH", path);
        }
        let output = command.output().await.map_err(|error| {
            ExtensionsError(format!(
                "failed to run npm {} in {}: {error}",
                arguments.join(" "),
                functions.display()
            ))
        })?;
        if !output.status.success() && arguments[0] == "install" {
            return Err(ExtensionsError(format!(
                "npm install failed in {} ({}):\n{}{}",
                functions.display(),
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        // `npm run gcp-build` on a package without that script exits non-zero
        // in the official emulator too; only a spawn error is fatal there.
    }
    Ok(())
}

/// Copies a source directory tree (a vendoring step).
pub fn copy_tree(from: &Path, to: &Path) -> Result<(), ExtensionsError> {
    std::fs::create_dir_all(to)
        .map_err(|error| ExtensionsError(format!("failed to create {}: {error}", to.display())))?;
    for entry in std::fs::read_dir(from)
        .map_err(|error| ExtensionsError(format!("failed to read {}: {error}", from.display())))?
    {
        let entry = entry.map_err(|error| {
            ExtensionsError(format!("failed to read {}: {error}", from.display()))
        })?;
        let source = entry.path();
        let destination = to.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|error| ExtensionsError(error.to_string()))?;
        if kind.is_dir() {
            copy_tree(&source, &destination)?;
        } else if kind.is_symlink() {
            let link =
                std::fs::read_link(&source).map_err(|error| ExtensionsError(error.to_string()))?;
            let _ = std::fs::remove_file(&destination);
            #[cfg(unix)]
            std::os::unix::fs::symlink(&link, &destination).map_err(|error| {
                ExtensionsError(format!("failed to link {}: {error}", destination.display()))
            })?;
            #[cfg(not(unix))]
            std::fs::copy(&source, &destination).map_err(|error| {
                ExtensionsError(format!("failed to copy {}: {error}", destination.display()))
            })?;
        } else {
            std::fs::copy(&source, &destination).map_err(|error| {
                ExtensionsError(format!("failed to copy {}: {error}", destination.display()))
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_validity_requires_both_files() {
        let directory = tempfile::tempdir().unwrap();
        assert!(!has_valid_source(directory.path()));
        std::fs::write(directory.path().join("extension.yaml"), "name: x\n").unwrap();
        assert!(!has_valid_source(directory.path()));
        std::fs::create_dir_all(directory.path().join("functions")).unwrap();
        std::fs::write(directory.path().join("functions/package.json"), "{}").unwrap();
        assert!(has_valid_source(directory.path()));
    }

    #[test]
    fn vendor_manifest_round_trips() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(vendored_version(directory.path(), "pub/ext@^1"), None);
        record_vendored_version(directory.path(), "pub/ext@^1", "1.2.3").unwrap();
        record_vendored_version(directory.path(), "pub/other", "2.0.0").unwrap();
        assert_eq!(
            vendored_version(directory.path(), "pub/ext@^1").as_deref(),
            Some("1.2.3")
        );
        assert_eq!(
            vendored_version(directory.path(), "pub/other").as_deref(),
            Some("2.0.0")
        );
    }

    #[test]
    fn archives_extract_below_the_target() {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("extension.yaml", options).unwrap();
            std::io::Write::write_all(&mut writer, b"name: x\n").unwrap();
            writer.add_directory("functions/", options).unwrap();
            writer
                .start_file("functions/package.json", options)
                .unwrap();
            std::io::Write::write_all(&mut writer, b"{}").unwrap();
            writer.finish().unwrap();
        }
        let directory = tempfile::tempdir().unwrap();
        extract_zip(buffer.get_ref(), directory.path()).unwrap();
        assert!(has_valid_source(directory.path()));
    }
}
