# Financials dashboard

A static React/shadcn dashboard with a Rust WASM analysis engine. Financial
statements come directly from Alpha Vantage through the `alpha_vantage` Rust
crate and are cached locally in the user's browser with IndexedDB.

Charts show 5 or 10 fiscal years, amounts in reporting-currency millions, gross
margin, CAPEX, D&A and cash generation. The app includes statement tables and
CSV export. No financial-data backend is needed.

## Build and run locally

Requires Node 22.12+, npm and Rust/rustup:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
cd web
npm ci
npm run build
npm run preview -- --host 127.0.0.1
```

Open http://localhost:4173, choose **Set up Alpha Vantage**, save your key, and
enter a ticker. Saved data is reused until you refresh or clear it. Fetches retry
up to three times on transient failures and quota limits.

The static page is built at **web/dist/index.html**. Serve the entire `web/dist/`
directory over HTTP or HTTPS; opening the HTML with `file://` is unsupported.

## Deploy with GitHub Pages

1. Push this project to a GitHub repository.
2. In **Settings → Pages → Build and deployment**, set **Source** to
   **GitHub Actions**.
3. Push to the repository's default branch, or run **Web, WASM and GitHub Pages**
   manually from the **Actions** tab with that branch selected. If the initial
   push ran before Pages was enabled, rerun the workflow after step 2.

The [workflow](.github/workflows/web.yml) builds Rust/WASM and the dashboard,
runs Rust and browser checks, then deploys only the static `web/dist/` output.
The Pages configuration supplies the correct base path for repository sites,
user sites and configured custom domains. Pull requests and other branches run
checks under a sample repository subpath without deploying. The deployment URL
appears in the workflow's `github-pages` environment.

No Alpha Vantage secret is needed in GitHub Actions. Each visitor enters their
own key in the browser. Cached data and keys are local to the browser and site
origin; data saved on localhost does not transfer to the hosted site.

See [web/README.md](web/README.md) for key storage, cache behavior, data mappings,
manual static deployment and verification commands.
