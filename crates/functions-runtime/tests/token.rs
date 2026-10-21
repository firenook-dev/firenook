//! The demo credentials' token, inside a real Node worker: a function's
//! Admin SDK holds the synthetic credential and refreshes it at Google's
//! token endpoint (firebase-admin 12 and earlier at
//! www.googleapis.com/oauth2/v4/token, the Google auth library of 13 and
//! later at oauth2.googleapis.com/token), and the worker answers that
//! refresh in the process.

mod support;

use axum::body::Body;
use axum::http::Request;
use firenook_functions_runtime::LogDelivery;
use serde_json::{Value, json};
use support::{Harness, PROJECT};

// Each refresh is sent as the SDK sends it, with a name lookup that refuses
// every host: a request the worker does not answer fails at once, and none
// reaches the network.
const INDEX: &str = r#"
const https = require("node:https");
const GRANT = "client_id=demo&client_secret=demo&refresh_token=demo&grant_type=refresh_token";
const refuse = (host, _options, callback) => callback(Object.assign(new Error("would have left the machine for " + host), { code: "ENOTFOUND" }));
function refresh(url) {
  return new Promise((resolve) => {
    const request = https.request(url, { method: "POST", lookup: refuse, headers: { "content-type": "application/x-www-form-urlencoded" } }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on("error", (error) => resolve({ error: error.message }));
    request.end(GRANT);
  });
}
exports.credentials = (req, res) => {
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  res.json({ file: file ?? null, content: file ? JSON.parse(require("node:fs").readFileSync(file, "utf8")) : null });
};
exports.token = async (req, res) => {
  res.json({
    legacy: await refresh("https://www.googleapis.com/oauth2/v4/token"),
    current: await refresh("https://oauth2.googleapis.com/token"),
  });
};
"#;

const MANIFEST: &str = "specVersion: v1alpha1
endpoints:
  credentials:
    entryPoint: credentials
    platform: gcfv2
    httpsTrigger: {}
  token:
    entryPoint: token
    platform: gcfv2
    httpsTrigger: {}
";

#[tokio::test]
async fn the_demo_refresh_is_answered_at_both_google_endpoints() {
    let harness = match Harness::start(INDEX, MANIFEST, LogDelivery::Attributed).await {
        Ok(harness) => harness,
        Err(reason) => {
            eprintln!("skipped: {reason}");
            return;
        }
    };
    let (response, text) = harness
        .call_text(
            Request::get(format!("/{PROJECT}/us-central1/token"))
                .body(Body::empty())
                .expect("a request"),
        )
        .await;
    assert_eq!(response.status(), 200, "{text}");
    let answers: Value = serde_json::from_str(&text).expect("json");
    let owner = json!({
        "status": 200,
        "body": {"access_token": "owner", "expires_in": 3600, "token_type": "Bearer"}
    });
    assert_eq!(
        answers["legacy"], owner,
        "firebase-admin 12 and earlier: {text}"
    );
    assert_eq!(
        answers["current"], owner,
        "firebase-admin 13 and later: {text}"
    );
    harness.stop().await;
}

#[tokio::test]
async fn every_admin_sdk_finds_the_synthetic_credential_first() {
    // firebase-admin 12 and earlier read GOOGLE_APPLICATION_CREDENTIALS and
    // then $HOME/.config/gcloud (%APPDATA%\\gcloud on Windows), never
    // CLOUDSDK_CONFIG: without the variable they would find the developer's
    // own gcloud login and refresh it at Google.
    let harness = match Harness::start(INDEX, MANIFEST, LogDelivery::Attributed).await {
        Ok(harness) => harness,
        Err(reason) => {
            eprintln!("skipped: {reason}");
            return;
        }
    };
    let (response, text) = harness
        .call_text(
            Request::get(format!("/{PROJECT}/us-central1/credentials"))
                .body(Body::empty())
                .expect("a request"),
        )
        .await;
    assert_eq!(response.status(), 200, "{text}");
    let answer: Value = serde_json::from_str(&text).expect("json");
    let file = answer["file"]
        .as_str()
        .expect("GOOGLE_APPLICATION_CREDENTIALS is set");
    assert!(
        std::path::Path::new(file)
            .starts_with(harness.directory.path().canonicalize().expect("path")),
        "the run's own file: {file}"
    );
    assert_eq!(
        answer["content"],
        json!({"type": "authorized_user", "client_id": "demo", "client_secret": "demo", "refresh_token": "demo"})
    );
    harness.stop().await;
}
