# Financials web app

A static React/shadcn dashboard backed by a Rust WASM analysis engine and the
`alpha_vantage` Rust crate. Alpha Vantage is the only live financial-data source.
The interface uses shadcn's default neutral dark theme and chart colors.

## Start and set up your key

```sh
# From web/, after building
npm run preview -- --host 127.0.0.1
```

Open http://localhost:4173. The first visit opens **Set up Alpha Vantage**:

1. Follow the link to https://www.alphavantage.co/support/#api-key and create a key.
2. Paste it into the password field and choose **Save API key**. This stores the
   key locally; the first stock request checks it with Alpha Vantage, without a
   separate verification request consuming quota.
3. Close settings and enter an Alpha Vantage ticker. Four sequential requests
   fetch income, balance sheet, cash flow, and company overview. Overview is
   optional: the ticker is used if that call fails. A fifth request loads daily
   prices independently after the statements open.

The key stays in sessionStorage by default. **Remember my key on this device**
opts into localStorage; only use it on a trusted device. Keys are sent directly
to Alpha Vantage, never to our static host, and are excluded from IndexedDB and
CSV exports. **Forget API key** removes this tab's key and the remembered key;
other already-open tabs can still hold their session copy until closed.
No API keys belong in source files, build variables or deployment configuration.

The free provider allowance is currently 25 API requests/day. Temporary network failures, timeouts, HTTP 408/5xx and quota-limit responses
(including HTTP 429 and provider JSON quota messages) retry
automatically up to three times per endpoint, after 1, 2 and 4 seconds (at most
four attempts total, even when failure types change). Invalid keys, other HTTP
4xx responses and malformed data are not retried. Retries can consume API allowance. International statement availability is provider-
dependent; market-price coverage is not a guarantee of statement coverage.

## Local disk cache

IndexedDB database `financials-alphavantage-v1` stores raw statements in the
browser profile, scoped to this site's origin. The `stocks` store holds complete
snapshots and `pending` holds interrupted downloads. Schema version 3 includes
`prices` and `metadata` stores, preserving existing statements and price data
during upgrades. Metadata tracks cache clearing so earlier price downloads
cannot save afterward, including across tabs. None of these stores contains an API key.

- A saved ticker is read before any network request or key requirement.
- Cached statements survive reloads, tabs and browser restarts in normal profiles.
- They have **no TTL and no automatic refresh**. **Refresh data** explicitly
  downloads a new snapshot; a failed refresh keeps the previous snapshot usable.
- Successful partial downloads are saved. A retry resumes the missing endpoints.
- A tab shares in-progress loads; Web Locks also prevents duplicate first loads
  of the same ticker across tabs where supported.
- Changing the fiscal-year window recalculates locally in WASM.
- Data settings lists saved tickers and provides a cache-clear control. CSV export
  produces an ordinary downloadable file; IndexedDB itself is browser-managed.
- Saving the key requests persistent storage through `navigator.storage.persist()`.
  Browsers can decline. Clearing site data, private browsing, storage pressure,
  a different browser/profile, or changing host/port can remove or hide the cache.
- Storage failures are surfaced. A successful download that cannot be committed
  can still be analyzed, but the UI warns that later visits may need another call.

Saved reports need no provider connection. The static app assets must still be
available to open/reload the page; this is not a service-worker offline app.

## Stock price chart

The price panel shows the latest available daily close and its absolute and
percentage change from the previous trading session. The [daily price endpoint](https://www.alphavantage.co/documentation/#daily)
requests `outputsize=full`, covering every daily session the provider has for
the ticker. Full daily history requires a premium Alpha Vantage key. Provider
coverage (documented as 25+ years) may begin after an older company’s listing;
All does not imply prices exist before listing or before provider coverage.
Prices are unadjusted for splits and dividends, and are not real-time quotes.
The feed supplies no currency, so the panel labels values as
exchange quote units instead of assuming the financial statements' currency.

The 1M, 3M, 3Y and 5Y controls select calendar windows ending on the latest loaded
session; All shows every available session without a date or row-count cap.
These controls and the statement fiscal-year controls are independent and use
no additional requests. Hover or
use the chart's keyboard navigation to inspect daily closing prices.

Prices load after statements and full-history snapshots are cached independently
with no automatic refresh. Legacy compact snapshots are upgraded once a key is
available; without a key or if the upgrade fails, they remain usable with a
limited-history notice. A failed upgrade does not replace the saved snapshot.
**Refresh price** updates only prices; **Refresh data** updates financial
statements. A failed price download leaves statements usable, and a failed
price refresh keeps the previous chart. **Clear saved statements** removes
prices as well, and prevents pending price downloads from restoring them.
Those downloads may still finish for the current view without being saved.
Older saved stocks fetch prices when a key is available;
without a key they still open, with a setup action in the price panel.

## Build and deploy

Requires Node 22.12+, npm, Rust/rustup, and wasm-bindgen-cli 0.2.126:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
cd web
npm ci
npm run build
npm run preview -- --host 127.0.0.1
```

`npm run build` compiles Rust to WASM, generates bindings, checks TypeScript, and
builds `web/dist/`. Upload **all of dist/** to any HTTPS static host. Serve WASM
as `application/wasm`. Use HTTP on localhost for development, not `file://`.
No financial-data backend, application server, container, or MCP server is
required. Alpha Vantage currently allows cross-origin browser API requests.
`npm run preview` is for local inspection only; production deployment consists
solely of the generated files in `dist/`.

For subdirectory hosting, set `BASE_PATH=/financials/` during the build.
For development use `npm run dev`; run `npm run wasm` after Rust changes.

For **GitHub Pages**, enable **Settings → Pages → Source → GitHub Actions**, then
push to the default branch or manually run **Web, WASM and GitHub Pages** on that
branch. The [workflow](../.github/workflows/web.yml) obtains the base path from
GitHub Pages, builds and tests the site, and deploys only `web/dist/`. It supports
repository subpaths, user sites and configured custom domains. Pull requests
and other branches run checks without publishing. No provider key is needed in
Actions; visitors supply their own key. See the [root README](../README.md) for
the initial setup sequence.

## Rust client choice and mappings

`alpha_vantage` **0.11.0** is pinned in Cargo.lock and used by the browser/WASM
provider client. It builds requests via its documented `custom` builder
and parses provider `Information`, `Note`, and `Error Message` responses. The
small `HttpClient` adapter in `crates/financial-core/src/provider.rs` supplies
browser fetch with a 25-second timeout or native reqwest. Browser futures are
wrapped with `send_wrapper` because the crate requires Send futures, while the
WASM build executes on one browser thread. No fork/vendor copy is needed.

Alternatives examined: `alphavantage` 0.7.1 lists only price-series/exchange-rate
operations; `borsa-alphavantage` 0.2.0 depends on `alpha_vantage` while adding a
native Tokio market-data abstraction. The selected crate exposes the statement
functions with less unrelated code. This is a fit decision, not a claim that a
crate's age or download count guarantees quality.

Provider responses are mapped in `alpha.rs`; statement calculations stay in Rust. Numeric
strings are parsed strictly, and `None`, null, blank and nonfinite values stay
missing. All available annual periods are retained. Charts show 5 or 10 fiscal
years in reporting-currency millions; ratios use percentages or multiples.
No currency conversion or external verification of reported values is performed.

Gross PP&E = net PP&E + absolute accumulated depreciation. Working capital =
current assets − current liabilities. Free cash flow = operating cash flow −
absolute CAPEX. Gross profit can be derived from revenue − cost of revenue.
D&A uses the cash-flow statement's depreciation/depletion/amortization field.
Current receivables can include non-trade items. The debt-issuance row uses net
long-term debt and capital-security proceeds. These definitions appear in the UI.
Unsupported rows (including basic/diluted EPS, debt repayments and cash-position
balances) remain blank. Product/service revenue segments are not supplied by the
selected endpoints; the revenue-breakdown card states that limitation.

References: [crate](https://crates.io/crates/alpha_vantage),
[provider API](https://www.alphavantage.co/documentation/#fundamentals),
[field definitions](https://documentation.alphavantage.co/FundamentalDataDocs/gaap_documentation.html).

## Verification

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd web
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

Browser tests intercept provider HTTP responses but execute the actual compiled
Rust client and analysis WASM. They cover setup, key retention/removal, quota
errors, partial download recovery, explicit refresh, IndexedDB reload/tab reuse,
cache clearing, no-key cache access, chart calculations, CSV export and mobile
layout. Price checks cover daily changes, range selection, keyboard tooltips,
independent refresh, malformed data, ticker switching, and cache migration.
Fixtures are synthetic; tests do not vet real company financial values.

The browser suite runs against Vite preview with the same `BASE_PATH` as the
build. To check repository-subpath hosting locally, run `BASE_PATH=/financials/ npm run build` and `BASE_PATH=/financials/ npm run test:e2e` (each on one line).
CI uses the configured Pages base path for deployments and `/financials/` for
other branches.
