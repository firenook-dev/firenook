//! What the native SDKs and browsers send, in the shapes recorded in
//! `conformance/fixtures/storage-native-clients-v1`.
use super::*;
use axum::body::to_bytes;
use axum::http::Request;
use firenook_functions_bridge::TriggerObserver;
use tower::ServiceExt as _;

const BUCKET: &str = "demo-native.appspot.com";

struct Fixture {
    runtime: StorageRuntime,
    root: std::path::PathBuf,
}

impl Fixture {
    async fn start(test: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "firenook-native-clients-{test}-{}-{}",
            std::process::id(),
            now_rfc3339().replace(':', "-")
        ));
        let registry = TriggerRegistry::default();
        let (observer, _receiver) = TriggerObserver::channel(registry.clone());
        let runtime = StorageRuntime::start(
            StorageConfig {
                project: "demo-native".to_owned(),
                durability: StorageDurability::default(),
                origin: "http://127.0.0.1:21003".to_owned(),
                data_dir: root.clone(),
                rules: None,
            },
            observer.queue(),
            registry,
        )
        .await
        .expect("runtime");
        Self { runtime, root }
    }

    async fn send(&self, request: Request<Body>) -> (StatusCode, HeaderMap, JsonValue) {
        let response = self
            .runtime
            .application()
            .oneshot(request)
            .await
            .expect("response");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 1_048_576)
            .await
            .expect("body");
        let body = serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null);
        (status, headers, body)
    }

    async fn stop(self) {
        self.runtime.shutdown().await.expect("shutdown");
        std::fs::remove_dir_all(self.root).expect("isolated test cleanup");
    }
}

fn ios_start(object: &str, name: &str, body: &str) -> Request<Body> {
    Request::post(format!(
        "/v0/b/{BUCKET}/o/{object}?uploadType=resumable&name={object}"
    ))
    .header("x-goog-upload-protocol", "resumable")
    .header("x-goog-upload-command", "start")
    .header("x-goog-upload-content-length", "5")
    .header("x-goog-upload-content-type", "text/plain")
    .header(header::CONTENT_TYPE, "application/json; charset=UTF-8")
    .header(header::HOST, "127.0.0.1:21003")
    .body(Body::from(
        body.replace("{name}", name)
            .replace("{bucket}", "")
            .into_bytes(),
    ))
    .expect("request")
}

fn upload_path(headers: &HeaderMap) -> String {
    let url = url::Url::parse(
        headers
            .get("x-goog-upload-url")
            .and_then(|value| value.to_str().ok())
            .expect("upload url"),
    )
    .expect("url");
    format!("{}?{}", url.path(), url.query().expect("query"))
}

fn command(method: &str, path: &str, command: &str, bytes: &'static [u8]) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header("x-goog-upload-protocol", "resumable")
        .header("x-goog-upload-command", command)
        .header("x-goog-upload-offset", "0")
        .body(Body::from(bytes))
        .expect("request")
}

#[tokio::test]
async fn the_ios_start_on_an_object_path_is_an_upload_that_finishes_by_put() {
    let fixture = Fixture::start("ios").await;
    let (status, headers, _) = fixture
        .send(ios_start(
            "open%2Fhello.txt",
            "open/hello.txt",
            r#"{"contentType":"text/plain","bucket":"{bucket}","metadata":{"k":"v"},"name":"{name}"}"#,
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-goog-upload-status"], "active");
    let path = upload_path(&headers);
    assert!(path.starts_with(&format!("/v0/b/{BUCKET}/o?name=open%2Fhello.txt")));

    let (status, headers, _) = fixture.send(command("PUT", &path, "upload", b"hel")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-goog-upload-status"], "active");
    let (status, headers, _) = fixture.send(command("POST", &path, "query", b"")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-goog-upload-size-received"], "3");

    let (status, headers, object) = fixture
        .send(command("PUT", &path, "upload, finalize", b"lo"))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-goog-upload-status"], "final");
    assert_eq!(object["name"], "open/hello.txt");
    assert_eq!(object["contentType"], "text/plain");
    assert_eq!(object["size"], "5");
    assert_eq!(object["metadata"]["k"], "v");
    fixture.stop().await;
}

#[tokio::test]
async fn the_path_names_the_object_whatever_the_query_and_body_say() {
    let fixture = Fixture::start("names").await;
    let (status, headers, _) = fixture
        .send(
            Request::post(format!(
                "/v0/b/{BUCKET}/o/open%2Fpath.txt?uploadType=resumable&name=open%2Fquery.txt"
            ))
            .header("x-goog-upload-protocol", "resumable")
            .header("x-goog-upload-command", "start")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"name":"open/body.txt"}"#))
            .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, object) = fixture
        .send(command(
            "POST",
            &upload_path(&headers),
            "upload, finalize",
            b"x",
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(object["name"], "open/path.txt");
    fixture.stop().await;
}

#[tokio::test]
async fn only_the_body_of_a_firebase_start_sets_the_type() {
    let fixture = Fixture::start("types").await;
    // What the Android SDK sends with custom metadata and no content type.
    let (status, headers, _) = fixture
        .send(
            Request::post(format!(
                "/v0/b/{BUCKET}/o?name=open%2Funtyped.png&uploadType=resumable"
            ))
            .header("x-goog-upload-protocol", "resumable")
            .header("x-goog-upload-command", "start")
            .header("x-goog-upload-header-content-type", "image/png")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"metadata":{"k":"v"}}"#))
            .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, _, object) = fixture
        .send(command(
            "POST",
            &upload_path(&headers),
            "upload, finalize",
            b"x",
        ))
        .await;
    assert_eq!(object["contentType"], "application/octet-stream");

    // No body at all, as it sends with no metadata, finishing with no bytes.
    let (status, headers, _) = fixture
        .send(
            Request::post(format!(
                "/v0/b/{BUCKET}/o?name=open%2Fplain.bin&uploadType=resumable"
            ))
            .header("x-goog-upload-protocol", "resumable")
            .header("x-goog-upload-command", "start")
            .body(Body::empty())
            .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let path = upload_path(&headers);
    let (_, _, _) = fixture.send(command("POST", &path, "upload", b"abc")).await;
    let (status, _, object) = fixture.send(command("POST", &path, "finalize", b"")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(object["size"], "3");
    assert_eq!(object["contentType"], "application/octet-stream");

    // The Cloud Storage API still takes the type from its headers.
    let (status, headers, _) = fixture
        .send(
            Request::post(format!(
                "/upload/storage/v1/b/{BUCKET}/o?uploadType=resumable&name=open%2Fgcs.png"
            ))
            .header("x-upload-content-type", "image/png")
            .body(Body::empty())
            .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let location = url::Url::parse(headers[header::LOCATION].to_str().expect("location header"))
        .expect("location");
    let (status, _, object) = fixture
        .send(
            Request::put(format!(
                "{}?{}",
                location.path(),
                location.query().expect("query")
            ))
            .body(Body::from("x"))
            .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(object["contentType"], "image/png");
    fixture.stop().await;
}

#[tokio::test]
async fn download_tokens_stay_admin_only_on_the_upload_route() {
    let fixture = Fixture::start("tokens").await;
    let upload = || {
        Request::post(format!("/v0/b/{BUCKET}/o?name=open%2Fa.txt"))
            .header(header::AUTHORIZATION, "Bearer owner")
            .body(Body::from("a"))
            .expect("request")
    };
    assert_eq!(fixture.send(upload()).await.0, StatusCode::OK);
    let token = |query: &str, owner: bool| {
        let builder = Request::post(format!("/v0/b/{BUCKET}/o/open%2Fa.txt?{query}"));
        if owner {
            builder.header(header::AUTHORIZATION, "Bearer owner")
        } else {
            builder
        }
        .body(Body::empty())
        .expect("request")
    };
    for query in ["create_token=true", "delete_token=x"] {
        let (status, _, body) = fixture.send(token(query, false)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{query}");
        assert_eq!(body["error"]["message"], "Missing admin credentials.");
    }
    assert_eq!(
        fixture.send(token("create_token=true", true)).await.0,
        StatusCode::OK
    );
    fixture.stop().await;
}

#[tokio::test]
async fn a_put_can_stand_in_for_a_patch() {
    let fixture = Fixture::start("patch").await;
    let (status, _, _) = fixture
        .send(
            Request::post(format!("/v0/b/{BUCKET}/o?name=open%2Fa.txt"))
                .header(header::AUTHORIZATION, "Bearer owner")
                .body(Body::from("a"))
                .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, object) = fixture
        .send(
            Request::put(format!("/v0/b/{BUCKET}/o/open%2Fa.txt"))
                .header("x-http-method-override", "PATCH")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer owner")
                .body(Body::from(r#"{"metadata":{"k":"patched"}}"#))
                .expect("request"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(object["metadata"]["k"], "patched");
    fixture.stop().await;
}

#[tokio::test]
async fn a_browser_may_send_what_it_asks_and_read_the_upload_headers() {
    let fixture = Fixture::start("cors").await;
    let asked = "authorization,x-goog-upload-header-content-length,x-goog-upload-header-content-type,x-made-up-header";
    let (status, headers, _) = fixture
        .send(
            Request::options(format!("/v0/b/{BUCKET}/o"))
                .header(header::ORIGIN, "http://localhost:5000")
                .header("access-control-request-method", "POST")
                .header("access-control-request-headers", asked)
                .header("access-control-request-private-network", "true")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
    assert!(status.is_success());
    assert_eq!(headers["access-control-allow-headers"], asked);
    assert_eq!(headers["access-control-allow-private-network"], "true");
    assert_eq!(headers["access-control-allow-origin"], "*");

    let (_, headers, _) = fixture
        .send(
            Request::post(format!("/v0/b/{BUCKET}/o?name=open%2Fa.txt"))
                .header(header::ORIGIN, "http://localhost:5000")
                .header("x-goog-upload-protocol", "resumable")
                .header("x-goog-upload-command", "start")
                .body(Body::empty())
                .expect("request"),
        )
        .await;
    let exposed = headers["access-control-expose-headers"]
        .to_str()
        .expect("exposed");
    for header in [
        "x-goog-upload-url",
        "x-goog-upload-status",
        "x-goog-upload-size-received",
    ] {
        assert!(exposed.split(',').any(|name| name == header), "{header}");
    }
    assert!(!headers.contains_key("access-control-allow-private-network"));
    fixture.stop().await;
}
