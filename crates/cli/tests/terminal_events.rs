//! What the engine tells the terminal UI (`--terminal-events`): a count
//! says its noun in the singular for one, a start-up warning from any
//! service reaches the `ready` event, which the terminal's `w` key lists,
//! and a service's line after it is a line of the log, never a raw one.

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde_json::Value;

/// A fresh project directory, removed when dropped.
struct Project {
    path: PathBuf,
    id: String,
}

impl Project {
    fn new(name: &str) -> Self {
        let id = format!("demo-events-{name}-{}", std::process::id());
        let path = std::env::temp_dir().join(format!("firenook-{id}"));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("project directory");
        Self { path, id }
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("directory");
        }
        std::fs::write(path, text).expect("written");
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A running engine, the events it sent, and every line it printed (those
/// on stderr also apart).
struct Engine {
    child: Child,
    events: Arc<Mutex<Vec<Value>>>,
    output: Arc<Mutex<Vec<String>>>,
    errors: Arc<Mutex<Vec<String>>>,
}

impl Engine {
    fn printed(&self) -> String {
        self.output.lock().expect("output").join("\n")
    }

    fn events(&self) -> Vec<Value> {
        self.events.lock().expect("events").clone()
    }
}

fn free_ports<const N: usize>() -> [u16; N] {
    let listeners: Vec<TcpListener> = (0..N)
        .map(|_| TcpListener::bind("127.0.0.1:0").expect("port"))
        .collect();
    std::array::from_fn(|index| listeners[index].local_addr().expect("address").port())
}

/// The Node binary on `PATH`, which a suite with Functions needs.
fn node() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|candidate| candidate.is_file())
}

/// Starts the engine with the terminal's events (picking up its saved data
/// with `resume`) and waits for `ready`.
fn start(project: &Project, only: &str, resume: bool, ports: [u16; 11]) -> Engine {
    launch(project, only, resume, true, ports)
}

/// Starts the engine as a pipe or CI runs it, and waits for its ready line.
fn start_plain(project: &Project, only: &str, ports: [u16; 11]) -> Engine {
    launch(project, only, false, false, ports)
}

/// The engine `child` is, reading both its streams into its records; the
/// channel says when it is ready.
fn read(mut child: Child) -> (Engine, mpsc::Receiver<()>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let output = Arc::new(Mutex::new(Vec::new()));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let (ready, became_ready) = mpsc::channel();
    for (stream, stderr) in [
        (
            Box::new(child.stdout.take().expect("stdout")) as Box<dyn std::io::Read + Send>,
            false,
        ),
        (Box::new(child.stderr.take().expect("stderr")), true),
    ] {
        let (events, output, errors, ready) = (
            Arc::clone(&events),
            Arc::clone(&output),
            Arc::clone(&errors),
            ready.clone(),
        );
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if let Some(event) = line.strip_prefix("FIRENOOK_EVENT ")
                    && let Ok(event) = serde_json::from_str::<Value>(event)
                {
                    if event["type"] == "ready" {
                        let _ = ready.send(());
                    }
                    events.lock().expect("events").push(event);
                } else if line == "All emulators ready" {
                    let _ = ready.send(());
                }
                if stderr {
                    errors.lock().expect("errors").push(line.clone());
                }
                output.lock().expect("output").push(line);
            }
        });
    }
    let engine = Engine {
        child,
        events,
        output,
        errors,
    };
    (engine, became_ready)
}

fn launch(project: &Project, only: &str, resume: bool, events: bool, ports: [u16; 11]) -> Engine {
    let names = [
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
    let mut command = Command::new(env!("CARGO_BIN_EXE_firenook"));
    command
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
        .arg("--no-ui")
        .args(["--project-id", &project.id, "--host", "127.0.0.1"])
        .args([
            "--node".as_ref(),
            node()
                .unwrap_or_else(|| PathBuf::from("/nonexistent/firenook-test-node"))
                .as_os_str(),
        ])
        .args(["--minimum-functions", "0", "--only", only]);
    if resume {
        command.arg("--resume-state");
    }
    if events {
        command.arg("--terminal-events");
    }
    for (name, port) in names.iter().zip(ports) {
        command.args([format!("--{name}-port"), port.to_string()]);
    }
    let child = command
        .env("FIRENOOK_CONTROL_STDIN", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("engine started");
    let (mut engine, became_ready) = read(child);
    let deadline = Instant::now() + Duration::from_secs(120);
    while became_ready
        .recv_timeout(Duration::from_millis(100))
        .is_err()
    {
        let ended = engine.child.try_wait().expect("status").is_some();
        if ended || Instant::now() > deadline {
            let _ = engine.child.kill();
            std::thread::sleep(Duration::from_millis(100));
            panic!("the engine never became ready:\n{}", engine.printed());
        }
    }
    engine
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

/// The figures a start-up row ended with.
fn figures(engine: &Engine, id: &str) -> Value {
    engine
        .events()
        .into_iter()
        .find(|event| event["type"] == "step" && event["id"] == id && event["state"] == "done")
        .unwrap_or_else(|| panic!("no {id} row ended:\n{}", engine.printed()))["figures"]
        .clone()
}

#[test]
fn one_document_is_one_document() {
    let project = Project::new("count");
    project.write("firebase.json", r#"{"firestore":{}}"#);
    let ports = free_ports::<11>();
    let engine = start(&project, "firestore,auth,storage", true, ports);
    assert_eq!(
        figures(&engine, "firestore"),
        serde_json::json!([[0, "documents"]])
    );
    write_document(&project.id, ports[0]);
    stop(engine);
    let engine = start(&project, "firestore,auth,storage", true, ports);
    assert_eq!(
        figures(&engine, "firestore"),
        serde_json::json!([[1, "document"]]),
        "{}",
        engine.printed()
    );
    stop(engine);
}

#[test]
fn a_schedule_that_cannot_run_on_a_clock_is_a_start_up_warning() {
    if node().is_none() {
        eprintln!("skipped: node is not on PATH, and a suite with Functions needs it");
        return;
    }
    let project = Project::new("schedule");
    project.write(
        "firebase.json",
        r#"{"functions":[{"source":"functions"}],"emulators":{"pubsub":{}}}"#,
    );
    // A static manifest loads without Node; Mars has no time zone.
    project.write(
        "functions/functions.yaml",
        "specVersion: v1alpha1\nendpoints:\n  cleanup:\n    entryPoint: cleanup\n    platform: gcfv2\n    scheduleTrigger:\n      schedule: every day 03:00\n      timeZone: Mars/Olympus_Mons\n",
    );
    project.write(
        "functions/package.json",
        r#"{"name":"schedules","main":"index.js"}"#,
    );
    project.write("functions/index.js", "");
    let engine = start(&project, "functions,pubsub", false, free_ports::<11>());
    let ready = engine
        .events()
        .into_iter()
        .find(|event| event["type"] == "ready")
        .expect("ready");
    let warnings = ready["warnings"].as_array().expect("warnings").clone();
    assert!(
        warnings
            .iter()
            .any(|warning| warning.as_str().is_some_and(
                |text| text.contains("schedule of") && text.contains("not run automatically")
            )),
        "the schedule's warning is a start-up warning: {warnings:?}\n{}",
        engine.printed()
    );
    assert_eq!(
        figures(&engine, "pubsub"),
        serde_json::json!([[1, "schedule"]])
    );
    stop(engine);
}

/// A request to a local port, and the status line it answered with.
fn post(port: u16, path: &str, body: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connected");
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .expect("request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("response");
    response.lines().next().unwrap_or_default().to_owned()
}

#[test]
fn a_cloud_tasks_line_once_running_is_a_line_of_the_log() {
    if node().is_none() {
        eprintln!("skipped: node is not on PATH, and a suite with Functions needs it");
        return;
    }
    let project = Project::new("tasks");
    project.write("firebase.json", r#"{"functions":[{"source":"functions"}]}"#);
    project.write(
        "functions/functions.yaml",
        "specVersion: v1alpha1\nendpoints:\n  api:\n    entryPoint: api\n    platform: gcfv2\n    httpsTrigger: {}\n",
    );
    project.write(
        "functions/package.json",
        r#"{"name":"tasks","main":"index.js"}"#,
    );
    project.write("functions/index.js", "");
    let ports = free_ports::<11>();
    let engine = start(&project, "functions", false, ports);
    // A task for a queue no function registers: Cloud Tasks warns.
    let status = post(
        ports[9],
        &format!(
            "/projects/{}/locations/us-central1/queues/missing/tasks",
            project.id
        ),
        "{}",
    );
    assert!(status.contains(" 404"), "{status}");
    let deadline = Instant::now() + Duration::from_secs(10);
    let said = loop {
        let found = engine.events().into_iter().find(|event| {
            event["type"] == "log"
                && event["source"] == "tasks"
                && event["message"]
                    .as_str()
                    .is_some_and(|text| text.contains("non-existent queue"))
        });
        if found.is_some() || Instant::now() > deadline {
            break found;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let said =
        said.unwrap_or_else(|| panic!("the warning is a line of the log:\n{}", engine.printed()));
    assert_eq!(said["level"], "warn");
    assert!(
        !engine.printed().contains("firenook tasks: Tried to queue"),
        "nothing is printed raw:\n{}",
        engine.printed()
    );
    stop(engine);
}

/// The log line a source said whose message holds `text`, waited for.
fn said(engine: &Engine, source: &str, text: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let found = engine.events().into_iter().find(|event| {
            event["type"] == "log"
                && event["source"] == source
                && event["message"]
                    .as_str()
                    .is_some_and(|message| message.contains(text))
        });
        if let Some(found) = found {
            return found;
        }
        assert!(
            Instant::now() < deadline,
            "{source} said no line with {text:?}:\n{}",
            engine.printed()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn an_auth_link_once_running_is_a_line_of_the_log() {
    let project = Project::new("auth");
    project.write("firebase.json", r#"{"emulators":{"auth":{}}}"#);
    let ports = free_ports::<11>();
    let engine = start(&project, "auth", false, ports);
    let status = post(
        ports[1],
        "/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=fake-api-key",
        r#"{"requestType":"EMAIL_SIGNIN","email":"ada@example.com","continueUrl":"http://127.0.0.1/done","canHandleCodeInApp":true}"#,
    );
    assert!(status.contains(" 200"), "{status}\n{}", engine.printed());
    let line = said(
        &engine,
        "auth",
        "To sign in as ada@example.com, follow this link: ",
    );
    assert_eq!(line["level"], "info");
    assert!(
        line["message"]
            .as_str()
            .is_some_and(|text| text.contains("oobCode=")),
        "{line}"
    );
    assert!(
        !engine.printed().contains("firenook auth: To sign in"),
        "nothing is printed raw:\n{}",
        engine.printed()
    );
    stop(engine);
}

#[test]
fn a_storage_rules_failure_once_running_is_a_line_of_the_log() {
    let project = Project::new("storage");
    project.write("firebase.json", r#"{"storage":{"rules":"storage.rules"}}"#);
    // Reading a field of a missing auth is an error, not a denial.
    project.write(
        "storage.rules",
        "rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read: if request.auth.token.admin == true; } } }\n",
    );
    let ports = free_ports::<11>();
    let engine = start(&project, "storage", false, ports);
    let mut stream = TcpStream::connect(("127.0.0.1", ports[2])).expect("Storage");
    write!(
        stream,
        "GET /v0/b/{}.appspot.com/o/report.pdf HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        project.id
    )
    .expect("request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("response");
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    let line = said(&engine, "storage", "failed in the rules");
    assert_eq!(line["level"], "warn");
    assert!(
        !engine.printed().contains("firenook Storage rules:"),
        "nothing is printed raw:\n{}",
        engine.printed()
    );
    stop(engine);
}

#[test]
fn the_plain_lines_stay_as_they_were() {
    let project = Project::new("plain");
    project.write(
        "firebase.json",
        r#"{"emulators":{"auth":{}},"storage":{"rules":"storage.rules"}}"#,
    );
    project.write(
        "storage.rules",
        "rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read: if request.auth.token.admin == true; } } }\n",
    );
    let ports = free_ports::<11>();
    let engine = start_plain(&project, "auth,storage", ports);
    post(
        ports[1],
        "/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=fake-api-key",
        r#"{"requestType":"EMAIL_SIGNIN","email":"ada@example.com","continueUrl":"http://127.0.0.1/done"}"#,
    );
    let mut stream = TcpStream::connect(("127.0.0.1", ports[2])).expect("Storage");
    write!(
        stream,
        "GET /v0/b/{}.appspot.com/o/report.pdf HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        project.id
    )
    .expect("request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("response");
    let deadline = Instant::now() + Duration::from_secs(10);
    let rules = "firenook Storage rules: get on gs://";
    while !engine.printed().contains(rules) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let printed = engine.printed();
    assert!(
        printed.contains("firenook auth: To sign in as ada@example.com, follow this link: "),
        "{printed}"
    );
    let errors = engine.errors.lock().expect("errors").join("\n");
    assert!(
        errors.contains(rules),
        "a warning goes to stderr:\n{printed}"
    );
    assert!(
        !errors.contains("firenook auth: To sign in"),
        "an information line goes to stdout:\n{printed}"
    );
    assert!(!printed.contains("FIRENOOK_EVENT"), "{printed}");
    stop(engine);
}
