# Financials dashboard

A React dashboard with Rust WASM data acquisition and analysis. The browser
calls **Yahoo Finance → SEC EDGAR → optional Alpha Vantage** directly. Statements
and daily prices stay in IndexedDB, with sources preserved per metric and date.
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
npm run preview
```

Open the preview URL. For development, run `npm run wasm` then `npm run dev`.
Search without a key; **Data settings** accepts an optional Alpha Vantage key
for gaps. Only Alpha Vantage receives that key, directly from browser WASM.

## Deployment

Serve `web/dist` on any static host, including GitHub Pages. No provider server
or `VITE_PROVIDER_URL` is required. `BASE_PATH` configures a hosting subdirectory;
the Pages workflow supplies it automatically.

Requests use browser Fetch through Rust WASM. Browser and upstream access
policies still apply; this implementation does not bypass CORS. Saved reports
remain readable when providers are unavailable.

The native service remains available for separate API consumers:

```sh
SEC_USER_AGENT='YourApp/1.0 your-real-contact@example.org' \
  cargo run -p financial-providers --features server
```

Native builds need OpenSSL development headers and pkg-config on Linux.
`BIND_ADDR` defaults to `127.0.0.1:3001`, and `WEB_DIST` to `web/dist`.
The dashboard uses its browser providers even when served by this service.

See [provider architecture](docs/providers.md), [web notes](web/README.md), and
[local crate patches](vendor/README.md).
