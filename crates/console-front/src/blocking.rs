//! CPU-bound or store-scanning work, off the request threads.

use crate::api_error::ApiError;

/// Runs `work` on the blocking pool. A task that panicked answers
/// `internal` with "`what` did not finish", so a fault in one evaluation is
/// a 500 for that request and never takes the worker down with it.
pub(crate) async fn blocking<T: Send + 'static>(
    what: &'static str,
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| ApiError::internal(format!("{what} did not finish")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_error::ErrorCode;

    #[tokio::test]
    async fn the_answer_comes_back_and_a_panic_is_an_internal_error() {
        assert_eq!(blocking("the sum", || Ok(2 + 2)).await.expect("ok"), 4);
        let refused = blocking::<()>("the sum", || Err(ApiError::invalid("no")))
            .await
            .expect_err("refused");
        assert_eq!(refused.detail().code, ErrorCode::InvalidArgument);
        let panicked = blocking::<()>("the explain task", || panic!("synthetic"))
            .await
            .expect_err("panicked");
        assert_eq!(panicked.detail().code, ErrorCode::Internal);
        assert_eq!(panicked.detail().message, "the explain task did not finish");
    }
}
