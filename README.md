# Financials dashboard

A React dashboard with a Rust WASM analysis engine and a native Rust provider
service. New downloads prefer **Yahoo Finance → SEC EDGAR → Alpha Vantage**.
Alpha Vantage is optional and is called only for remaining information that its
endpoints support. Saved statements and prices remain in browser IndexedDB.

Charts and tables cover 5 or 10 fiscal years, cash generation, margins and daily
prices, with CSV export. Sources are preserved per metric and fiscal date.

## Run locally

Requires Rust 1.91+, the WASM target, wasm-bindgen-cli 0.2.126, Node 22.12+ and npm.
On Linux, native builds also need the OpenSSL development package and pkg-config.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
cd web
npm ci
npm run build
cd ..
SEC_USER_AGENT='YourApp/1.0 your-real-contact@example.org' cargo run -p financial-providers
```

Replace the SEC user agent with your application and real contact email. Open
http://127.0.0.1:3001. Search without a key; **Data settings** lets you add an
optional Alpha Vantage key for gaps. The browser sends that key in a POST body
to the configured service, which forwards it only to Alpha Vantage when needed.
The service does not persist keys or log request bodies.

For UI development, run the service and `npm run dev` in `web/`; Vite proxies
`/api` to port 3001. The native service also serves the production `web/dist/`.

## Deployment

Run the native service on your server behind HTTPS. `BIND_ADDR` defaults to
`127.0.0.1:3001`; `WEB_DIST` defaults to `web/dist`. The service must have outbound
access to Yahoo, SEC and (when used) Alpha Vantage. Multiple service instances
must coordinate SEC traffic to stay within the SEC's aggregate access limits.

GitHub Pages can host the static UI, but **cannot run the provider service**.
For Pages, set the repository variable `VITE_PROVIDER_URL` to your deployed
HTTPS service URL ending in `/api`, and set `WEB_ORIGIN` on the service to your
exact Pages origin (scheme and hostname, without the repository path). The
workflow builds and tests the UI and deploys static assets. Without a configured
service, existing saved reports remain readable, but new downloads cannot work.
There is no automatic browser-only Alpha Vantage bypass.

See [provider architecture](docs/providers.md) for selection rules and crate
choices, and [web notes](web/README.md) for caching and verification.
