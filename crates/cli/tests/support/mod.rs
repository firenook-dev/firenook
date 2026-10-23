//! What the suite-lifecycle tests share: a scratch directory with project
//! folders and a private temporary directory, an engine started as the npm
//! launcher starts it, and plain HTTP. Every engine runs on free ports with
//! its own temporary directory, so the Hub locators it writes are the
//! test's own. Each test file uses part of it.
#![allow(dead_code)]

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

pub(crate) const RULES: &str = "rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }\n";

/// A directory the test owns, removed when dropped: one or more project
/// folders and the temporary directory every engine of the test shares.
pub(crate) struct Scratch {
    pub(crate) root: PathBuf,
}

impl Scratch {
    pub(crate) fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("firenook-lifecycle-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("tmp")).expect("scratch directory");
        Self { root }
    }

    /// The temporary directory the engines are given (`TMPDIR`), where
    /// they write their Hub locators.
    pub(crate) fn tmp(&self) -> PathBuf {
        self.root.join("tmp")
    }

    /// A project folder with a firebase.json serving Firestore and Auth.
    pub(crate) fn project(&self, folder: &str, firebase_json: &str) -> PathBuf {
        let path = self.root.join(folder);
        std::fs::create_dir_all(&path).expect("project directory");
        std::fs::write(path.join("firebase.json"), firebase_json).expect("firebase.json");
        std::fs::write(path.join("firestore.rules"), RULES).expect("rules");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub(crate) const FIRESTORE_AND_AUTH: &str =
    r#"{"firestore":{"rules":"firestore.rules"},"emulators":{"firestore":{},"auth":{}}}"#;

pub(crate) const LISTENERS: [&str; 11] = [
    "firestore",
    "auth",
    "storage",
    "functions",
    "pubsub",
    "hub",
    "ui",
    "logging",
    "eventarc",
    "tasks",
    "firestore-websocket",
];

pub(crate) fn free_ports() -> [u16; 11] {
    let listeners: Vec<TcpListener> = (0..11)
        .map(|_| TcpListener::bind("127.0.0.1:0").expect("port"))
        .collect();
    std::array::from_fn(|index| listeners[index].local_addr().expect("address").port())
}

pub(crate) fn port(ports: &[u16; 11], name: &str) -> u16 {
    ports[LISTENERS
        .iter()
        .position(|listener| *listener == name)
        .expect("listener name")]
}

/// How a test starts an engine.
pub(crate) struct Launch<'a> {
    pub(crate) project: &'a Path,
    pub(crate) id: &'a str,
    pub(crate) tmp: &'a Path,
    pub(crate) ports: [u16; 11],
    pub(crate) only: &'a str,
    pub(crate) host: &'a str,
    pub(crate) extra: Vec<String>,
}

impl<'a> Launch<'a> {
    pub(crate) fn new(project: &'a Path, id: &'a str, tmp: &'a Path) -> Self {
        Self {
            project,
            id,
            tmp,
            ports: free_ports(),
            only: "firestore,auth",
            host: "127.0.0.1",
            extra: Vec::new(),
        }
    }
}

/// A running engine and everything it printed.
pub(crate) struct Engine {
    pub(crate) child: Child,
    pub(crate) output: Arc<Mutex<Vec<String>>>,
    pub(crate) ports: [u16; 11],
}

/// Starts the engine as the npm launcher does (its private stdin pipe, the
/// output on pipes) and waits for its ready line.
pub(crate) fn start(launch: &Launch<'_>) -> Engine {
    let engine = spawn(launch);
    wait_ready(engine)
}

pub(crate) fn spawn(launch: &Launch<'_>) -> Engine {
    spawn_with(launch, Stdio::piped(), Stdio::piped())
}

pub(crate) fn spawn_with(launch: &Launch<'_>, stdout: Stdio, stderr: Stdio) -> Engine {
    let mut command = Command::new(env!("CARGO_BIN_EXE_firenook"));
    command
        .arg("suite")
        .args(["--project-dir".as_ref(), launch.project.as_os_str()])
        .args([
            "--config".as_ref(),
            launch.project.join("firebase.json").as_os_str(),
        ])
        .args([
            "--state-dir".as_ref(),
            launch.project.join("state").as_os_str(),
        ])
        .args(["--project-id", launch.id, "--host", launch.host])
        .args(["--node", "/nonexistent/firenook-test-node"])
        .args(["--minimum-functions", "0", "--only", launch.only]);
    for (name, port) in LISTENERS.iter().zip(launch.ports) {
        command.args([format!("--{name}-port"), port.to_string()]);
    }
    let child = command
        .args(&launch.extra)
        .env("FIRENOOK_CONTROL_STDIN", "1")
        .env("TMPDIR", launch.tmp)
        .env("TEMP", launch.tmp)
        .env("TMP", launch.tmp)
        .stdin(Stdio::piped())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
        .expect("engine started");
    Engine {
        child,
        output: Arc::new(Mutex::new(Vec::new())),
        ports: launch.ports,
    }
}

pub(crate) fn wait_ready(mut engine: Engine) -> Engine {
    let (ready, became_ready) = mpsc::channel();
    for stream in [
        Box::new(engine.child.stdout.take().expect("stdout")) as Box<dyn std::io::Read + Send>,
        Box::new(engine.child.stderr.take().expect("stderr")),
    ] {
        let (output, ready) = (Arc::clone(&engine.output), ready.clone());
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
    let deadline = Instant::now() + Duration::from_secs(120);
    while became_ready
        .recv_timeout(Duration::from_millis(100))
        .is_err()
    {
        let exited = engine.child.try_wait().expect("status");
        if exited.is_some() || Instant::now() > deadline {
            let _ = engine.child.kill();
            let _ = engine.child.wait();
            std::thread::sleep(Duration::from_millis(200));
            panic!(
                "the engine never became ready ({exited:?}):\n{}",
                engine.printed()
            );
        }
    }
    engine
}

impl Engine {
    pub(crate) fn printed(&self) -> String {
        self.output.lock().expect("output").join("\n")
    }

    pub(crate) fn port(&self, name: &str) -> u16 {
        port(&self.ports, name)
    }

    /// Waits for the exit; a test that never sees one fails.
    pub(crate) fn wait(&mut self, within: Duration) -> ExitStatus {
        let deadline = Instant::now() + within;
        loop {
            if let Some(status) = self.child.try_wait().expect("status") {
                // The readers finish with the pipes; give them a moment.
                std::thread::sleep(Duration::from_millis(100));
                return status;
            }
            if Instant::now() > deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                panic!("the engine did not stop:\n{}", self.printed());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Asks for a stop the way the npm CLI does and waits for the exit.
    pub(crate) fn stop(mut self) -> (ExitStatus, String) {
        self.child
            .stdin
            .take()
            .expect("stdin")
            .write_all(b"FIRENOOK_SHUTDOWN\n")
            .expect("stop sent");
        let status = self.wait(Duration::from_secs(60));
        (status, self.printed())
    }
}

/// One HTTP/1.1 exchange on a fresh connection; the response as text.
pub(crate) fn http(address: &str, request: &str) -> String {
    let mut stream = TcpStream::connect(address).unwrap_or_else(|error| {
        panic!("connect {address}: {error}");
    });
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .expect("timeout");
    stream.write_all(request.as_bytes()).expect("request");
    let mut response = Vec::new();
    let mut buffer = [0_u8; 8192];
    // Until the server closes; a reset after the response keeps what came.
    while let Ok(read) = stream.read(&mut buffer) {
        if read == 0 {
            break;
        }
        response.extend_from_slice(&buffer[..read]);
    }
    String::from_utf8_lossy(&response).into_owned()
}

pub(crate) fn get(address: &str, path: &str) -> String {
    http(
        address,
        &format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"),
    )
}

/// One document, written the way a client writes it.
pub(crate) fn write_document(project: &str, port: u16, id: &str) {
    let body = r#"{"fields":{"n":{"integerValue":"1"}}}"#;
    let response = http(
        &format!("127.0.0.1:{port}"),
        &format!(
            "PATCH /v1/projects/{project}/databases/(default)/documents/orders/{id} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer owner\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    );
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
}

/// Whether redb opens the file read-only, which it refuses while the file
/// is still marked for repair.
pub(crate) fn opens_without_repair(path: &Path) -> bool {
    redb::Builder::new().open_read_only(path).is_ok()
}

pub(crate) fn json_file(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|error| {
        panic!("{}: {error}", path.display());
    }))
    .expect("JSON")
}
