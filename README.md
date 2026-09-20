# Financials dashboard

A static React dashboard with Rust/WASM provider clients and analysis. The
browser calls **Yahoo Finance → SEC EDGAR → optional Alpha Vantage** directly;
a small Cloudflare Worker proxies the Yahoo and SEC requests, since neither
grants CORS to arbitrary origins, and keeps a shared edge copy of the answers
that change slowly (never of an option chain). Statements and daily prices stay
in IndexedDB, with sources preserved per metric and date. The dashboard heads
with the company's own logo beside its name, fetched as a plain image keyed by
ticker and falling back to the ticker's monogram when no logo loads. One **time
span** at the top of the dashboard — a month out to every year on record, three
years by default — sets the window for everything that looks backwards: the
fiscal years the statements and their charts cover (3, 5 or 10 of them, since
Yahoo's free statement data reliably covers only about 3 years) and the stretch
of daily closes the price chart draws. Charts and tables cover cash generation,
margins and daily prices, with CSV export. The **Capital & D&A** tab, next to
the overview, holds the reinvestment picture on its own: the year's capital
expenditure, D&A, CAPEX / D&A, D&A / revenue and D&A / gross PP&E, then capital
investment against depreciation, the reinvestment pace and depreciation
intensity charted across the same window. The **Balance sheet** tab opens with
three donut charts — assets, liabilities and equity, each split into the lines
reported inside it for a chosen fiscal year, with whatever those lines leave
over drawn as one remaining slice.

The **Options** tab adds a Greeks-driven outlook: on request it downloads the
live Yahoo option chain nearest a chosen horizon — two weeks out to the LEAPS
two years away — prices every contract with Black-Scholes-Merton (re-solving
implied volatility when the quoted one is not usable), and ranks structures —
long calls or puts, debit and credit verticals, iron condors, straddles — by
expected profit, probability of profit and how tradeable the quotes are. That
horizon looks forward, at an expiration the chain has to list, so it stays the
tab's own control rather than following the dashboard's span. Two limits are
yours to set beside it: the most premium a structure may cost to open (3,000 by
default) and the least delta the contract carrying the view may have (0.65 by
default). The direction comes from the company's own fundamentals and its price
history; the volatility view from implied against realized. Every contract
shows its working: the inputs, d₁ and d₂, and each Greek's formula with this
contract's numbers substituted into it beside the result. Chains are quoted
intraday and are never saved to the browser. It is model output from end-of-day
data, not investment advice.

## Run locally

Requires Rust 1.91+, the WASM target, wasm-bindgen-cli 0.2.126 and Node 22.12+.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
cd worker && npm ci
echo "SEC_USER_AGENT=YourApp/1.0 your-real-contact@example.org" > .dev.vars
npm run dev &   # wrangler dev, http://127.0.0.1:8787
cd ../web && npm ci
echo 'VITE_PROVIDER_PROXY_URL=http://127.0.0.1:8787' > .env
npm run dev
```

Search without a key; **Data settings** accepts an optional Alpha Vantage key
for gaps. The browser sends that key only to Alpha Vantage, directly; Yahoo and
SEC requests never see it. See [worker notes](worker/README.md).

## Deployment

`web/dist` is fully static (GitHub Pages, in `.github/workflows/web.yml`).
`BASE_PATH` configures a hosting subdirectory. Deploy the Cloudflare Worker in
`worker/` first (`npm run deploy`, after `wrangler secret put SEC_USER_AGENT`),
then set `VITE_PROVIDER_PROXY_URL` to its origin before building the dashboard.
CI does this from repository secrets and a `PROVIDER_PROXY_URL` variable; see
[worker notes](worker/README.md) for the one-time setup.

An application-level `AllowAnyOrigin` setting only adds an
`Access-Control-Allow-Origin` header to responses served by that application.
It cannot add the header to Yahoo's or SEC's responses, so setting it on this
dashboard (or its static host) would not make direct requests to them succeed.
The Worker calls them server-side, without browser CORS enforcement, and
exposes its own permissive CORS policy in response, since it needs no browser
credentials.

See [provider architecture](docs/providers.md), [web notes](web/README.md),
[worker notes](worker/README.md), and [local crate patches](vendor/README.md).
