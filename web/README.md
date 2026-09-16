# Browser dashboard

The React UI calls the native provider service, then analyzes the returned
normalized annual data in Rust WASM. See the [root README](../README.md) for
startup and hosting, and [provider architecture](../docs/providers.md) for the
Yahoo → EDGAR → optional Alpha Vantage chain.

## Data and keys

Searches need no API key. Data settings can save an optional Alpha Vantage key
for the tab, or (when explicitly selected) in localStorage. The key is sent in
a POST body to the configured provider service, never saved in financial or
price snapshots, and never sent by the UI directly to an upstream provider.
Use a trusted HTTPS service when deploying remotely.

`VITE_PROVIDER_URL` is the service base URL ending in `/api`; default `/api`
works when the native service hosts the UI. Vite's development proxy points to
`http://127.0.0.1:3001`. GitHub Pages needs a separately hosted service and an
explicit URL at build time; browser CORS prevents relying on direct Yahoo/SEC
fetches. Service failures surface an error and do not bypass the fallback order.

## Cache

The existing IndexedDB `financials-alphavantage-v1` name is retained for migration.
Its `stocks`, `pending`, `prices` and `metadata` stores remain readable. New
snapshots use provider-neutral schema version 1 with metric/date provenance.
Legacy Alpha statements and prices still open. Pending legacy Alpha endpoint
downloads are not resumed by the new provider service.

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
cd web
npm ci
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

Browser tests mock `/api/*` but run actual WASM analysis, covering keyless loads,
optional key handling, provenance, statements/CSV, cache reuse, failed refresh,
price history and controls, delayed responses and cache-clear races. Provider
selection and upstream retry semantics are tested in Rust.
