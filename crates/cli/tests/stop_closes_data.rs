//! A stop once the emulators are ready leaves the data files closed: redb
//! clears its repair mark only when a database is dropped, and a file left
//! marked makes the next start repair it.

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

/// A fresh project directory, removed when dropped. Its project id is its
/// own: the Hub's locator file is named after it.
struct Project {
    path: PathBuf,
    id: String,
}

impl Project {
    fn new(name: &str) -> Self {
        let id = format!("demo-stop-{name}-{}", std::process::id());
        let path = std::env::temp_dir().join(format!("firenook-{id}"));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("project directory");
        std::fs::write(
            path.join("firebase.json"),
            r#"{"firestore":{"rules":"firestore.rules"}}"#,
        )
        .expect("firebase.json");
        std::fs::write(
            path.join("firestore.rules"),
            "rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }\n",
        )
        .expect("rules");
        Self { path, id }
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A running engine and everything it printed.
struct Engine {
    child: Child,
    output: Arc<Mutex<Vec<String>>>,
}

fn free_ports<const N: usize>() -> [u16; N] {
    let listeners: Vec<TcpListener> = (0..N)
        .map(|_| TcpListener::bind("127.0.0.1:0").expect("port"))
        .collect();
    std::array::from_fn(|index| listeners[index].local_addr().expect("address").port())
}

/// Starts the engine and waits for its ready line.
fn start(project: &Project, only: &str, ports: [u16; 11]) -> Engine {
    let [
        firestore,
        auth,
        storage,
        functions,
        pubsub,
        hub,
        ui,
        logging,
        eventarc,
        tasks,
        websocket,
    ] = ports;
    let mut child = Command::new(env!("CARGO_BIN_EXE_firenook"))
        .arg("suite")
        .args(["--project-dir".as_ref(), project.path.as_os_str()])
        .args([
            "--config".as_ref(),
            project.path.join("firebase.json").as_os_str(),
        ])
        .args([
            "--state-dir".as_ref(),
            project.path.join("state").as_os_str(),
        ])
        .args(["--project-id", &project.id, "--host", "127.0.0.1"])
        .args(["--node", "/nonexistent/firenook-test-node"])
        .args(["--minimum-functions", "0", "--only", only])
        .args(["--firestore-port", &firestore.to_string()])
        .args(["--auth-port", &auth.to_string()])
        .args(["--storage-port", &storage.to_string()])
        .args(["--functions-port", &functions.to_string()])
        .args(["--pubsub-port", &pubsub.to_string()])
        .args(["--hub-port", &hub.to_string()])
        .args(["--ui-port", &ui.to_string()])
        .args(["--logging-port", &logging.to_string()])
        .args(["--eventarc-port", &eventarc.to_string()])
        .args(["--tasks-port", &tasks.to_string()])
        .args(["--firestore-websocket-port", &websocket.to_string()])
        .env("FIRENOOK_CONTROL_STDIN", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("engine started");
    let output = Arc::new(Mutex::new(Vec::new()));
    let (ready, became_ready) = mpsc::channel();
    for stream in [
        Box::new(child.stdout.take().expect("stdout")) as Box<dyn std::io::Read + Send>,
        Box::new(child.stderr.take().expect("stderr")),
    ] {
        let (output, ready) = (Arc::clone(&output), ready.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                // Kept before `ready` is said, so the ready line is in the output.
                let became_ready = line.contains("All emulators ready");
                output.lock().expect("output").push(line);
                if became_ready {
                    let _ = ready.send(());
                }
            }
        });
    }
    let mut engine = Engine { child, output };
    if became_ready.recv_timeout(Duration::from_secs(120)).is_err() {
        let _ = engine.child.kill();
        panic!("the engine never became ready:\n{}", engine.printed());
    }
    engine
}

impl Engine {
    fn printed(&self) -> String {
        self.output.lock().expect("output").join("\n")
    }
}

/// One document, written the way a client writes it.
fn write_document(project: &str, port: u16) {
    let body = r#"{"fields":{"n":{"integerValue":"1"}}}"#;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("Firestore");
    write!(
        stream,
        "PATCH /v1/projects/{project}/databases/(default)/documents/orders/o_1 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer owner\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .expect("request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("response");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
}

/// Asks for a stop the way the npm CLI does and waits for the exit.
fn stop(mut engine: Engine) {
    engine
        .child
        .stdin
        .take()
        .expect("stdin")
        .write_all(b"FIRENOOK_SHUTDOWN\n")
        .expect("stop sent");
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = engine.child.try_wait().expect("status") {
            // The readers finish with the pipes; give them a moment.
            std::thread::sleep(Duration::from_millis(100));
            assert!(
                status.success(),
                "the stop failed ({status}):\n{}",
                engine.printed()
            );
            return;
        }
        if Instant::now() > deadline {
            let _ = engine.child.kill();
            panic!("the engine did not stop:\n{}", engine.printed());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Whether redb opens the file read-only, which it refuses while the file
/// is still marked for repair.
fn opens_without_repair(path: &Path) -> bool {
    redb::Builder::new().open_read_only(path).is_ok()
}

#[test]
fn a_stop_once_ready_closes_firestore_and_storage() {
    let project = Project::new("data");
    let ports = free_ports::<11>();
    let engine = start(&project, "firestore,auth,storage", ports);
    write_document(&project.id, ports[0]);
    stop(engine);
    let state = project.path.join("state");
    assert!(
        opens_without_repair(&state.join("firestore/firenook.redb")),
        "Firestore was left open"
    );
    assert!(
        opens_without_repair(&state.join("storage/metadata.redb")),
        "Storage was left open"
    );
}

#[test]
fn a_stop_once_ready_closes_firestore_alone() {
    let project = Project::new("firestore");
    let ports = free_ports::<11>();
    let engine = start(&project, "firestore", ports);
    write_document(&project.id, ports[0]);
    stop(engine);
    assert!(
        opens_without_repair(&project.path.join("state/firestore/firenook.redb")),
        "Firestore was left open"
    );
}
