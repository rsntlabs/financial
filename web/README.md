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

## Capital & D&A

Capital expenditure and depreciation have a tab of their own beside the
overview, since they only mean something read together. The panel heads with
the latest fiscal year's CAPEX, D&A, CAPEX / D&A, D&A / revenue and D&A /
gross PP&E, then charts the same three relationships across the window:
capital investment against depreciation, the reinvestment pace (CAPEX / D&A,
a multiple), and depreciation intensity against both revenue and gross fixed
assets. Cash CAPEX is carried as a positive outflow, so the pace is a positive
multiple: above 1 the asset base is growing, below it the base is being let
run down. Every figure comes from the same `financial-core` points the
overview and the statement tables use, so nothing is computed twice.

## Balance sheet composition

Above the balance-sheet table, three donut charts show assets, liabilities and
equity as shares of their own totals for one fiscal year at a time. The slices
are the lines the table already reports — cash, receivables, inventory and net
PP&E inside assets; payables, current and long-term debt inside liabilities;
retained earnings inside equity — and what those lines do not account for is
drawn as one remaining slice rather than left out of the circle.

The split is computed in `financial-core`, not in the browser, so the chart and
the table can never disagree. Nothing is clamped or rescaled to make a circle
close: a negative line (an accumulated deficit, treasury stock) or a set of
lines that adds up to more than the total it sits inside is not a share of
anything, so that ring is replaced by the reason it could not be drawn, and the
rows below carry the figures.

## Options outlook

The Options tab downloads a chain only when asked: chains are intraday quotes,
so nothing about them is cached, and opening the tab costs no request. The
horizon selector picks the expiration to analyze, from 14 days to two years, so
LEAPS are analyzed at the time value they actually carry rather than being cut
off at a year. The risk-free rate, the maximum premium (3,000 by default) and
the minimum delta (0.65 by default) are inputs too, since none of them is
provider data. The premium limit is the most a recommended structure may cost
to open, so a structure that collects premium is never limited by it; the delta
floor applies to the contract bought to carry the directional view, while legs
sold and the wings bought to define their risk are chosen by the shape of the
structure. Contracts outside either limit stay in the table, dimmed, since they
are still the market the recommendation was chosen from. Everything else — the Greeks, the
directional signal, the volatility regime and the ranked structures — is
computed by `financial-core` in WASM from the report, the saved daily closes and
the chain (see [provider architecture](../docs/providers.md)). Contracts whose
implied volatility the provider does not supply, or quotes outside a plausible
range, are re-solved from the mid price and labeled as such in the table.

The calculation card shows the derivation for any recommended leg or ranked
contract: the six inputs, the intermediate terms (d₁, d₂, N(d₁), N(d₂), φ(d₁),
the carry and discount factors), then delta, gamma, theta, vega and rho, each
with its formula, the same formula carrying this contract's numbers, the result
and its unit. Greeks are per share; one contract is 100 of them.

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
