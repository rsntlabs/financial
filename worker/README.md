# Provider proxy (Cloudflare Worker)

Proxies the dashboard's browser-side Yahoo Finance and SEC EDGAR requests.
Neither upstream grants CORS to arbitrary origins, so the WASM provider
adapters (`crates/financial-providers`, browser build) call this Worker
instead of calling Yahoo or SEC directly. See
[provider architecture](../docs/providers.md) for the full design.

The Worker owns the Yahoo session (cookie and crumb) and the real SEC
`User-Agent`; the browser never handles either, and every response keeps a
plain `Access-Control-Allow-Origin: *` since no credentials cross the
browser/proxy boundary. The dashboard asks for its statements, profile and
prices together, so that session is established once for a whole fan of
requests arriving at the same time, and a stale one costs a single handshake
however many of them it rejects. It also keeps a shared edge copy of the
answers that change slowly, so many readers of the same company cost the
upstreams one request rather than one each.

## Routes

- `GET /yahoo/chart/:symbol`, `/yahoo/quoteSummary/:symbol`,
  `/yahoo/timeseries/:symbol`, `/yahoo/options/:symbol` — proxy to the matching Yahoo Finance endpoint,
  with the Worker's own crumb and cookie injected (any client-supplied crumb
  is dropped). The browser client never fetches a real cookie or crumb of its
  own (see vendor/yfinance-rs's auth.rs patch), so there is no auth handshake
  route to serve.
- `GET /sec/files/company_tickers.json` — proxies to `www.sec.gov`.
- `GET /sec/api/xbrl/...` — proxies to `data.sec.gov`.
- `GET /health` — `{"status":"ok"}`.

## Cache

Every route above except `/yahoo/options/` and `/health` is answered from the
Cloudflare Cache API when a copy is there, and the upstream answer is put back
for the next reader. Each route's TTL comes from how fast the data behind it
actually moves:

| Route | TTL | Why |
| --- | --- | --- |
| `/yahoo/chart/` | 15 minutes | Daily closes; only the latest session moves, and the dashboard already calls these "not real-time". |
| `/yahoo/quoteSummary/` | 1 hour | Company profile and summary detail. |
| `/yahoo/timeseries/` | 6 hours | Annual statements, which change quarterly at most. |
| `/sec/api/` | 6 hours | Company facts, filed in batches. |
| `/sec/files/` | 24 hours | The ticker file changes rarely. |
| `/yahoo/options/` | never | Intraday quotes. |

Option chains are excluded on purpose rather than given a short TTL. They are
priced from the current bid and ask, so a minute-old copy of one is a wrong
answer rather than a slightly stale one — the same reason the dashboard never
saves a chain to IndexedDB either.

The cache key is the request path and its query, with `crumb` dropped and the
remaining parameters sorted. The crumb a client sends is a placeholder the
Worker replaces upstream and the real one changes on every session refresh, so
keying on it would split the cache by session rather than by what was asked.
Only `200` responses are kept, and a cache that errors or is missing entirely
(as under `vitest`, which has no Cache API) never fails a request the upstream
could still answer.

Nothing user-specific is cached: these routes carry public market data, the
upstream `Set-Cookie` is stripped before the copy is stored, and an Alpha
Vantage key never reaches this Worker at all (the browser calls Alpha
directly). Responses to the browser stay `Cache-Control: no-store`, so Refresh
data and Refresh price always reach the Worker rather than a browser-held
copy; what they get back may still be an edge copy up to its TTL old. A client
that needs to go past that can send `Cache-Control: no-cache` (or
`Pragma: no-cache`), which bypasses the lookup and replaces the stored copy
with what the upstream answers. Every response on a cached route says which
happened in `X-Proxy-Cache: HIT | MISS | BYPASS`.

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
