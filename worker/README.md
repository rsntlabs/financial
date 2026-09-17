# Provider proxy (Cloudflare Worker)

Proxies the dashboard's browser-side Yahoo Finance and SEC EDGAR requests.
Neither upstream grants CORS to arbitrary origins, so the WASM provider
adapters (`crates/financial-providers`, browser build) call this Worker
instead of calling Yahoo or SEC directly. See
[provider architecture](../docs/providers.md) for the full design.

The Worker owns the Yahoo session (cookie and crumb) and the real SEC
`User-Agent`; the browser never handles either, and every response keeps a
plain `Access-Control-Allow-Origin: *` since no credentials cross the
browser/proxy boundary.

## Routes

- `GET /yahoo/chart/:symbol`, `/yahoo/quoteSummary/:symbol`,
  `/yahoo/timeseries/:symbol` — proxy to the matching Yahoo Finance endpoint,
  with the Worker's own crumb and cookie injected (any client-supplied crumb
  is dropped). The browser client never fetches a real cookie or crumb of its
  own (see vendor/yfinance-rs's auth.rs patch), so there is no auth handshake
  route to serve.
- `GET /sec/files/company_tickers.json` — proxies to `www.sec.gov`.
- `GET /sec/api/xbrl/...` — proxies to `data.sec.gov`.
- `GET /health` — `{"status":"ok"}`.

## Run locally

```sh
npm ci
echo "SEC_USER_AGENT=YourApp/1.0 your-real-contact@example.org" > .dev.vars
npm run dev       # wrangler dev, defaults to http://127.0.0.1:8787
```

Point `web/.env`'s `VITE_PROVIDER_PROXY_URL` at that origin (see
`web/.env.example`). `.dev.vars` is local-only (gitignored); SEC EDGAR requests
fail without it, but Yahoo routes work either way.

## Test and typecheck

```sh
npm run typecheck
npm test
```

## Deploy

```sh
npm ci
wrangler secret put SEC_USER_AGENT   # "YourApp/1.0 your-real-contact@example.org"
npm run deploy
```

CI deploys automatically from the default branch once these repository
secrets exist: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`SEC_USER_AGENT`. Without them, `.github/workflows/web.yml`'s `deploy-worker`
job is skipped, not failed.

After the first deploy, set the repository **variable** (not secret)
`PROVIDER_PROXY_URL` to the Worker's `https://*.workers.dev` origin (or a
custom route) so the dashboard build points at it. It is a public URL, not a
key, so a plain variable is correct. Until it is set, CI builds the dashboard
against a placeholder that never resolves, so a missing configuration fails
obviously instead of pointing at the wrong host.

The deployed Worker is unauthenticated and has no aggregate rate limit of its
own (only a per-request timeout); it accepts requests from any origin because
that is what lets a static dashboard use it at all. Anyone who finds the
`*.workers.dev` URL can drive traffic through it, consuming your Cloudflare
quota and the `SEC_USER_AGENT` contact identity's standing with Yahoo/SEC.
Put rate limiting or authentication in front of it (a Cloudflare Rate Limiting
rule or Access policy) before treating this as more than a low-traffic,
personal deployment.
