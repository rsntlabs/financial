# Browser compatibility patches

These MIT-licensed crates are copied from the pinned crates.io releases. Their
licenses and source are retained. Root `[patch.crates-io]` entries make builds
reproducible without modifying the Cargo registry.

- `yfinance-rs` 0.9.1: use browser time and timers, replace Moka's worker-thread
  cache with a bounded in-memory cache on WASM, keep native-only proxy/runtime
  configuration out of the browser, and drop the WASM `credentials: 'include'`
  fetch mode. The browser build points every base URL at the Cloudflare Worker
  proxy (see [provider architecture](../docs/providers.md)), which owns the
  real Yahoo cookie/crumb session; no cookie needs to cross the browser/proxy
  boundary, so the proxy keeps a plain `Access-Control-Allow-Origin: *`. On
  WASM, `ensure_credentials` also skips the cookie/crumb network round trip
  entirely and stores a placeholder crumb instead, since the proxy discards
  and overwrites whatever crumb it receives anyway. Request timeouts still
  apply. The `HistoryService` Send contract is bridged with `SendWrapper` on
  the single browser thread. Request construction and financial/profile/history
  parsing remain upstream code.
- `edgar-rs` 0.1.0: select Governor's portable clock and browser timers on WASM
  instead of Quanta's OS clock. Its source is unchanged.

The vendored manifests omit upstream example/test/dev-dependency declarations;
workspace tests cover the adapters, and Playwright exercises the actual WASM
clients against upstream-shaped responses. Native code paths retain their
original transport, clocks, caches and runtime.

Upstream crate SHA-256 checksums:

```
yfinance-rs  d71693be5300f2e9b1cee66f2efe6ea08655583333dcbf314c14c2f6807ce07a
edgar-rs     09d7e5b5d31b0fa71542c3716040472f3e517ce2864f51d300b60c9824fb0208
```
