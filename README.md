# Financials dashboard

A static React dashboard with Rust/WASM provider clients and analysis. The
browser calls **Yahoo Finance → SEC EDGAR → optional Alpha Vantage** directly;
a small Cloudflare Worker proxies the Yahoo and SEC requests, since neither
grants CORS to arbitrary origins. Statements and daily prices stay in
IndexedDB, with sources preserved per metric and date. Charts and tables cover
3, 5 or 10 fiscal years (3 by default, since Yahoo's free statement data
reliably covers only about 3 years), cash generation, margins and daily
prices, with CSV export.

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
