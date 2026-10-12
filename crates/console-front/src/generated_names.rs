//! No two generated TypeScript types share a name.
//!
//! Every crate's ts-rs types land under `console/src/api/generated/`, the
//! foundation's at the root and each stream's in its own directory, and
//! `lib.rs` re-exports them into one namespace that the console imports
//! side by side. Two files exporting the same name (a stream's `JobState`
//! beside the foundation's) would compile on their own and then shadow each
//! other in the console. Each stream's types therefore carry their service
//! family's prefix (`Auth…`, `Storage…`, `Function…`, `Pubsub…`, `Tasks…`,
//! `Log…`), and this test holds every directory to it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The names a generated file exports: `export type Name`, `export
/// interface Name`, `export enum Name`, `export const Name`.
fn exported(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix("export ")?;
            let rest = ["type ", "interface ", "enum ", "const "]
                .iter()
                .find_map(|keyword| rest.strip_prefix(keyword))?;
            let name: String = rest
                .chars()
                .take_while(|character| character.is_alphanumeric() || *character == '_')
                .collect();
            (!name.is_empty()).then_some(name)
        })
        .collect()
}

/// Every `.ts` file under `root`, recursively.
fn files(root: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "ts") {
            found.push(path);
        }
    }
}

/// Each name exported by more than one file under `root`, with the files
/// (relative to `root`), as one sentence per name.
fn collisions(root: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    files(root, &mut paths);
    let mut owners: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for path in paths {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .display()
            .to_string();
        for name in exported(&text) {
            owners.entry(name).or_default().push(relative.clone());
        }
    }
    owners
        .into_iter()
        .filter(|(_, files)| files.len() > 1)
        .map(|(name, mut files)| {
            files.sort();
            format!("{name} is exported by {}", files.join(" and "))
        })
        .collect()
}

/// A fresh directory under the system's temporary directory.
fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "firenook-generated-names-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).expect("scratch directory");
    directory
}

#[test]
fn no_two_generated_types_share_a_name() {
    // Everything this crate exports, written afresh where no other test
    // writes at the same time.
    let fresh = scratch("export");
    crate::tests::export_all_bindings(&ts_rs::Config::new().with_out_dir(&fresh));
    let mut written = Vec::new();
    files(&fresh, &mut written);
    assert!(written.len() > 50, "{} files exported", written.len());
    let clashes = collisions(&fresh);
    let _ = std::fs::remove_dir_all(&fresh);
    assert!(clashes.is_empty(), "{}", clashes.join("\n"));
    // And what the console reads, other crates' exports included.
    let committed = collisions(Path::new(crate::tests::GENERATED));
    assert!(committed.is_empty(), "{}", committed.join("\n"));
}

#[test]
fn a_duplicate_fails_naming_both_files() {
    let root = scratch("fixture");
    std::fs::create_dir_all(root.join("storage")).expect("directory");
    std::fs::write(
        root.join("JobState.ts"),
        "export type JobState = \"running\" | \"done\";\n",
    )
    .expect("written");
    std::fs::write(
        root.join("storage/JobState.ts"),
        "// generated\nexport type JobState = \"queued\";\n",
    )
    .expect("written");
    std::fs::write(
        root.join("storage/StorageObject.ts"),
        "import type { JobState } from \"../JobState\";\nexport type StorageObject<T> = { state: JobState };\n",
    )
    .expect("written");
    let clashes = collisions(&root);
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(
        clashes,
        [format!(
            "JobState is exported by JobState.ts and {}",
            Path::new("storage").join("JobState.ts").display()
        )]
    );
    assert_eq!(
        exported("export type Page<T> = { items: Array<T> };"),
        ["Page"]
    );
    assert_eq!(
        exported("import type { Total } from \"./Total\";"),
        Vec::<String>::new()
    );
}
