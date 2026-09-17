# Financials dashboard

A React dashboard with a Rust provider API and WASM analysis. The backend calls
**Yahoo Finance → SEC EDGAR → optional Alpha Vantage**. Statements and daily
prices stay in IndexedDB, with sources preserved per metric and date.
Charts and tables cover 5 or 10 fiscal years, cash generation, margins and daily
prices, with CSV export.

## Run locally

Requires Rust 1.91+, the WASM target, wasm-bindgen-cli 0.2.126 and Node 22.12+.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
cd web
npm ci
npm run build
cd ..
SEC_USER_AGENT='YourApp/1.0 your-real-contact@example.org' \
  cargo run -p financial-providers --features server
```

Open the backend URL. For development, run the backend and then `npm run wasm`
and `npm run dev`; Vite proxies `/api` to `127.0.0.1:3001`.
Search without a key; **Data settings** accepts an optional Alpha Vantage key
for gaps. The browser sends the key to the backend, which sends it only to Alpha
Vantage.

## Deployment

Serve `web/dist` through the provider server, or configure a static host to
forward `/api/*` to it. `BASE_PATH` configures a hosting subdirectory.

The static dashboard sends acquisition requests to `/api/financials` and
`/api/prices`; the Rust backend calls the upstream providers. Financial analysis
continues to run locally in WASM. Saved reports remain readable when the backend
or providers are unavailable.

An application-level `AllowAnyOrigin` setting only adds an
`Access-Control-Allow-Origin` header to responses served by that application. It
cannot add the header to Yahoo's responses, so setting it on this dashboard (or
its static host) would not make direct Yahoo requests succeed. A server-side
proxy can call Yahoo without browser CORS enforcement and expose its own CORS
policy. The optional backend below allows API requests from any origin so a
single static page can use it; protect public deployments with authentication
and rate limiting.

Run the backend and static dashboard together with:

```sh
SEC_USER_AGENT='YourApp/1.0 your-real-contact@example.org' \
  cargo run -p financial-providers --features server
```

Native builds need OpenSSL development headers and pkg-config on Linux.
`BIND_ADDR` defaults to `127.0.0.1:3001`, and `WEB_DIST` to `web/dist`.
The dashboard uses the API routes served by this service.

See [provider architecture](docs/providers.md), [web notes](web/README.md), and
[local crate patches](vendor/README.md).
