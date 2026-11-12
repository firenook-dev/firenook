//! The embedded assets live in `console/dist`, which only a console build
//! creates. A checkout without one (the differential harness, a fresh
//! `cargo build`) must still compile: the folder is guaranteed here, empty,
//! and the router then serves its build-needed page. Cargo re-runs the build
//! when anything in the folder changes (it walks a watched folder), so a
//! release binary re-embeds a new console build.
//!
//! Only the folder is watched. Cargo re-runs a build script on every build
//! while a watched path is missing, and `index.html` is missing until the
//! console is built: watching it recompiled this crate and the two above it
//! on every `cargo build` in such a checkout, about 43 s each time on a CI
//! runner, and the harness builds the engine in most of its steps.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dist = manifest.join("../../console/dist");
    let created = !dist.exists();
    std::fs::create_dir_all(&dist).expect("console/dist can be created");
    if created {
        // A folder made during this run is newer than the run, which the
        // next build takes for a change: date it to this script instead.
        // Best effort (Windows does not open a folder as a file), at worst
        // one more rebuild.
        if let Ok(time) = std::fs::metadata(manifest.join("build.rs")).and_then(|m| m.modified()) {
            let _ = std::fs::File::open(&dist).and_then(|folder| folder.set_modified(time));
        }
    }
    println!("cargo:rerun-if-changed={}", dist.display());
}
