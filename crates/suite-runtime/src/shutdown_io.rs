//! End connections the suite's drain is still waiting on. Stopping the accept
//! loop alone leaves WebChannel/gRPC responses open forever, and leaves an
//! HTTP connection that is mid-request open for the life of the process.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::Stream as _;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_stream::wrappers::WatchStream;
use tonic::transport::server::{Connected, TcpConnectInfo};

pub(super) struct ShutdownIo {
    socket: TcpStream,
    shutdown: WatchStream<bool>,
    closed: bool,
}

impl ShutdownIo {
    pub(super) fn new(socket: TcpStream, shutdown: watch::Receiver<bool>) -> Self {
        Self {
            socket,
            shutdown: WatchStream::new(shutdown),
            closed: false,
        }
    }

    fn check_shutdown(&mut self, context: &mut Context<'_>) -> io::Result<()> {
        // Poll the signal even while the underlying socket is idle, so a held
        // response cannot prevent server shutdown. Latch closure across polls.
        while !self.closed {
            match Pin::new(&mut self.shutdown).poll_next(context) {
                Poll::Ready(Some(false)) => {}
                Poll::Ready(Some(true) | None) => self.closed = true,
                Poll::Pending => break,
            }
        }
        if self.closed {
            Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "Firenook suite is shutting down",
            ))
        } else {
            Ok(())
        }
    }
}

/// Hands `axum` every accepted connection wrapped in [`ShutdownIo`], so a
/// listener's graceful drain can be brought to an end.
///
/// `axum`'s graceful shutdown stops the accept loop and then waits for the
/// connections already accepted. It closes the ones sitting idle between
/// requests, but a connection that has begun a request and not finished
/// sending it is not idle, so the wait never ends. One such client used to
/// hold the whole suite: it printed that it was stopping and then never
/// exited.
pub(super) struct ClosingListener<L> {
    inner: L,
    closing: watch::Receiver<bool>,
}

impl<L> ClosingListener<L> {
    pub(super) fn new(inner: L, closing: watch::Receiver<bool>) -> Self {
        Self { inner, closing }
    }
}

impl<L> axum::serve::Listener for ClosingListener<L>
where
    L: axum::serve::Listener<Io = TcpStream>,
{
    type Io = ShutdownIo;
    type Addr = L::Addr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (socket, address) = self.inner.accept().await;
        (ShutdownIo::new(socket, self.closing.clone()), address)
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

impl Connected for ShutdownIo {
    type ConnectInfo = TcpConnectInfo;
    fn connect_info(&self) -> Self::ConnectInfo {
        self.socket.connect_info()
    }
}

impl AsyncRead for ShutdownIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.check_shutdown(context)?;
        Pin::new(&mut self.socket).poll_read(context, buffer)
    }
}

impl AsyncWrite for ShutdownIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.check_shutdown(context)?;
        Pin::new(&mut self.socket).poll_write(context, buffer)
    }
    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check_shutdown(context)?;
        Pin::new(&mut self.socket).poll_flush(context)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(context)
    }
    fn is_write_vectored(&self) -> bool {
        self.socket.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        self.check_shutdown(context)?;
        Pin::new(&mut self.socket).poll_write_vectored(context, buffers)
    }
}
