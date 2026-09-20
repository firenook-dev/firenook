//! The embedded assets live in `console/dist`, which only a console build
//! creates. A checkout without one (the differential harness, a fresh
//! `cargo build`) must still compile: the folder is guaranteed here, empty,
//! and the router then serves its build-needed page. Cargo re-runs the build
//! when the folder's entries change so a release binary re-embeds a new
//! console build.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dist = manifest.join("../../console/dist");
    std::fs::create_dir_all(&dist).expect("console/dist can be created");
    println!("cargo:rerun-if-changed={}", dist.display());
    println!(
        "cargo:rerun-if-changed={}",
        dist.join("index.html").display()
    );
}
