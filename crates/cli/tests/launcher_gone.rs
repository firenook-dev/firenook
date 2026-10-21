//! The launcher that started the engine goes away without a word.

mod support;

use std::io::{BufRead as _, BufReader};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use support::{
    FIRESTORE_AND_AUTH, Launch, Scratch, opens_without_repair, spawn_with, write_document,
};

/// A launcher killed outright closes every pipe it held: the engine's
/// stdin reaches its end, and nothing reads the engine's output any more.
/// The engine stops as a stop asked for would, saving the data, and prints
/// nothing that could fail on the closed pipes.
#[test]
fn a_launcher_that_disappears_stops_the_engine_cleanly() {
    let scratch = Scratch::new("orphan");
    let id = format!("demo-orphan-{}", std::process::id());
    let dir = scratch.project("app", FIRESTORE_AND_AUTH);
    let tmp = scratch.tmp();
    // One pipe for both streams, so that one reader can close it.
    let (reader, writer) = std::io::pipe().expect("pipe");
    let mut engine = spawn_with(
        &Launch::new(&dir, &id, &tmp),
        writer.try_clone().expect("pipe").into(),
        writer.into(),
    );
    let (ready, became_ready) = mpsc::channel();
    let printed = Arc::clone(&engine.output);
    let reading = std::thread::spawn(move || {
        // Reads until the ready line, then lets the pipe go.
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let done = line.contains("All emulators ready");
            printed.lock().expect("output").push(line);
            if done {
                let _ = ready.send(());
                return;
            }
        }
    });
    if became_ready.recv_timeout(Duration::from_secs(120)).is_err() {
        let _ = engine.child.kill();
        panic!("the engine never became ready:\n{}", engine.printed());
    }
    reading.join().expect("reader");
    write_document(&id, engine.port("firestore"), "o_1");
    // The launcher's end: its stdin pipe closes too.
    drop(engine.child.stdin.take());
    let status = engine.wait(Duration::from_secs(60));
    assert!(status.success(), "the engine's stop failed: {status}");
    assert!(
        opens_without_repair(&dir.join("state/firestore/firenook.redb")),
        "Firestore was left open"
    );
    assert!(
        !tmp.join(format!("hub-{id}.json")).exists(),
        "the engine left its locator"
    );
}
