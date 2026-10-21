//! What the engine tells the terminal UI (`--terminal-events`): a start-up
//! warning from any service reaches the `ready` event, which the
//! terminal's `w` key lists.

use std::io::{BufRead as _, BufReader, Write as _};
use std::net::TcpListener;
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

/// A running engine and the events it sent.
struct Engine {
    child: Child,
    events: Arc<Mutex<Vec<Value>>>,
    output: Arc<Mutex<Vec<String>>>,
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
        .args(["--terminal-events", "--no-ui"])
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
    for (name, port) in names.iter().zip(ports) {
        command.args([format!("--{name}-port"), port.to_string()]);
    }
    let mut child = command
        .env("FIRENOOK_CONTROL_STDIN", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("engine started");
    let events = Arc::new(Mutex::new(Vec::new()));
    let output = Arc::new(Mutex::new(Vec::new()));
    let (ready, became_ready) = mpsc::channel();
    for stream in [
        Box::new(child.stdout.take().expect("stdout")) as Box<dyn std::io::Read + Send>,
        Box::new(child.stderr.take().expect("stderr")),
    ] {
        let (events, output, ready) = (Arc::clone(&events), Arc::clone(&output), ready.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if let Some(event) = line.strip_prefix("FIRENOOK_EVENT ")
                    && let Ok(event) = serde_json::from_str::<Value>(event)
                {
                    if event["type"] == "ready" {
                        let _ = ready.send(());
                    }
                    events.lock().expect("events").push(event);
                }
                output.lock().expect("output").push(line);
            }
        });
    }
    let mut engine = Engine {
        child,
        events,
        output,
    };
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
