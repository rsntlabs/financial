# Browser dashboard

React uses Rust/WASM for both provider acquisition and local analysis: the
`BrowserProviders` class (`crates/financial-providers`, browser build) runs
`yfinance-rs` and `edgar-rs` directly in the tab, trying Yahoo, SEC EDGAR, then
optional Alpha Vantage. Yahoo and SEC do not grant CORS to arbitrary origins,
so those two providers route through the Cloudflare Worker in `../worker`
instead of calling them directly; Alpha Vantage is called directly. See the
[root README](../README.md) for startup and static hosting, and
[provider architecture](../docs/providers.md) for the full design.

## Data and keys

Searches need no API key. Data settings can save an optional Alpha Vantage key
for the tab, or (when explicitly selected) in localStorage. WASM sends the key
only to Alpha Vantage when filling gaps. It is never included in Yahoo/SEC
requests or financial/price snapshots. API keys must not be build variables.

`npm run wasm` builds the provider and analysis module. `npm run dev` serves
the UI; `npm run build` also regenerates WASM for production. Set
`VITE_PROVIDER_PROXY_URL` (see `.env.example`) to a running Worker before
`npm run dev` — `cd ../worker && npm run dev` starts one on
`http://127.0.0.1:8787`.

## Cache

The existing IndexedDB `financials-alphavantage-v1` name is retained for migration.
Its `stocks`, `pending`, `prices` and `metadata` stores remain readable. New
snapshots use provider-neutral schema version 1 with metric/date provenance.
Legacy Alpha statements and prices still open. Pending legacy Alpha endpoint
downloads are not resumed by the browser provider chain.

Saved data has no automatic expiry. A saved ticker is opened before any network
request. Web Locks deduplicate first loads across tabs. Period controls operate
locally; use Refresh data with an ending year to acquire older history. Failed
refreshes keep the prior saved snapshot. Partial financial coverage with usable
revenue is saved with gap warnings. Add a key and refresh to try additional
coverage. Browser storage failures are shown to the user.

Prices load independently after statements. They prefer full Yahoo history and
fall back to Alpha only when needed. SEC supplies no daily prices. The chart
shows the latest daily close, daily change, and 1M/3M/3Y/5Y/All ranges ending on
the latest loaded session. All preserves every available session. Price source
is shown separately from financial sources; quote units are not assumed to
match reporting currency. Legacy compact histories are upgraded through the
provider chain, even without a key, and retained if upgrading fails.

Refresh price changes prices only. Clearing saved data removes financials and
prices and atomically invalidates in-flight price cache writes across tabs.
A download may still finish for the current view without being saved. Saved
reports work without providers, but UI assets still need to be served; this is
not a service-worker offline application. Browser/profile/origin changes,
private mode or storage eviction can affect persistence. CSV provides a portable
export.

## Checks

```sh
cargo fmt --all --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo clippy -p financial-providers --lib --target wasm32-unknown-unknown --locked -- -D warnings
cd web
npm ci
VITE_PROVIDER_PROXY_URL=https://financials-proxy.test npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

Browser tests run the real WASM provider chain and analysis engine, with the
Cloudflare Worker proxy's routes intercepted (see `tests/upstream.ts`). They
reject any direct browser request to Yahoo or SEC and cover acquisition
payloads, key handling, provenance, statements/CSV, cache reuse, failed
refreshes, full price history, delayed responses and cache-clear races. Rust
tests cover provider authentication, retries and fallback; `../worker` has its
own Vitest suite. No live provider quota is consumed.
