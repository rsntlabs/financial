use std::{future::Future, time::Duration};

pub(crate) const PROVIDER_TIMEOUT: Duration = Duration::from_secs(75);

pub(crate) async fn timeout<T>(duration: Duration, task: impl Future<Output = T>) -> Result<T, ()> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        tokio::time::timeout(duration, task).await.map_err(|_| ())
    }
    #[cfg(target_arch = "wasm32")]
    {
        use futures::future::{select, Either};
        let delay = futures_timer::Delay::new(duration);
        futures::pin_mut!(task, delay);
        match select(task, delay).await {
            Either::Left((value, _)) => Ok(value),
            Either::Right(_) => Err(()),
        }
    }
}
