# Browser compatibility patches

`yfinance-rs` is copied here from its pinned MIT-licensed crates.io release.
Its license and source are retained. The root `[patch.crates-io]` entry makes
builds reproducible without modifying the Cargo registry.

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

The vendored manifest omits upstream example/test/dev-dependency declarations;
workspace tests cover the adapters, and Playwright exercises the actual WASM
clients against upstream-shaped responses. Native code paths retain their
original transport, clocks, caches and runtime.

The patch cannot be replaced by manifest settings here: upstream asks for
`tokio`'s `rt-multi-thread` and for Moka unconditionally, and Cargo features
only ever add to what a dependency requests, so neither can be taken back from
this workspace. Dropping this copy needs the browser support to land upstream.

`edgar-rs` 0.1.0 is no longer vendored, and nothing about it needs patching. It
was copied here only to keep Quanta's OS clock out of the browser, and Quanta
now reads `globalThis.performance.now()` on `wasm32-unknown-unknown` (Governor's
own monotonic clock is `web-time` either way). Its one remaining browser need —
`futures-timer` on `wasm-bindgen`, which Governor's `std` feature pulls in for
`until_ready` — is additive, and `financial-providers` already asks for it, so
feature unification carries it into Governor's copy. The stock crate is pinned
in `Cargo.lock` by the registry checksum below.

Upstream crate SHA-256 checksums:

```
yfinance-rs  d71693be5300f2e9b1cee66f2efe6ea08655583333dcbf314c14c2f6807ce07a
edgar-rs     09d7e5b5d31b0fa71542c3716040472f3e517ce2864f51d300b60c9824fb0208
```

Cargo verifies the `edgar-rs` checksum on every build; the `yfinance-rs` one
records what this copy was taken from.
