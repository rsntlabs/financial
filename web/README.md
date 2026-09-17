# Browser dashboard

React calls `/api/financials` and `/api/prices` for acquisition and uses Rust
WASM for local analysis. The Rust backend runs `yfinance-rs` and `edgar-rs`, and
tries Yahoo, SEC EDGAR, then optional Alpha Vantage. Keeping provider requests
server-side avoids upstream browser CORS restrictions. The API permits requests
from any static-page origin; protect public deployments with authentication and
rate limiting.
See the [root README](../README.md) for startup and static hosting.

## Data and keys

Searches need no API key. Data settings can save an optional Alpha Vantage key
for the tab, or (when explicitly selected) in localStorage. WASM sends the key
only to Alpha Vantage when filling gaps. It is never included in Yahoo/SEC
requests or financial/price snapshots. API keys must not be build variables.

`npm run wasm` builds the analysis module. `npm run dev` serves the UI; `npm run
build` also regenerates WASM for production. The UI uses same-origin `/api`
paths, so development requires a backend or a dev proxy for those routes.

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
cargo test --workspace --features financial-providers/server --locked
cargo clippy --workspace --all-targets --features financial-providers/server --locked -- -D warnings
cargo clippy -p financial-providers --lib --target wasm32-unknown-unknown --locked -- -D warnings
cd web
npm ci
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

Browser tests intercept `/api` and run the actual WASM analysis. They reject any
direct browser request to Yahoo, SEC or Alpha and cover API payloads, key
handling, provenance, statements/CSV, cache reuse, failed refreshes, full price
history, delayed responses and cache-clear races. Rust tests cover provider
authentication, retries and fallback. No live provider quota is consumed.
