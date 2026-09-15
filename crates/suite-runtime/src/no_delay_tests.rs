use axum::serve::Listener as _;
use tokio::net::{TcpListener, TcpStream};

use crate::no_delay;

#[tokio::test]
async fn accepted_http_connections_disable_nagle() {
    // A plain listener hands out streams with Nagle enabled, which is the
    // condition that stalls multi-write responses on reused connections.
    let plain = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let _plain_client = TcpStream::connect(plain.local_addr().expect("address"))
        .await
        .expect("connect");
    let (plain_stream, _) = plain.accept().await.expect("accept");
    assert!(
        !plain_stream.nodelay().expect("nodelay flag"),
        "a plain accepted stream keeps Nagle"
    );

    let mut wrapped = no_delay(TcpListener::bind("127.0.0.1:0").await.expect("bind"));
    let _client = TcpStream::connect(wrapped.local_addr().expect("address"))
        .await
        .expect("connect");
    let (accepted, _) = wrapped.accept().await;
    assert!(
        accepted.nodelay().expect("nodelay flag"),
        "every accepted HTTP stream must set TCP_NODELAY"
    );
}
