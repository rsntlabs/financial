/**
 * Proxies browser-side yfinance and SEC EDGAR provider requests.
 *
 * Yahoo Finance and SEC EDGAR do not grant CORS to arbitrary origins, so the
 * dashboard's WASM provider adapters call this Worker instead of calling them
 * directly. The Worker owns the Yahoo session (cookie + crumb) and the real
 * SEC User-Agent; the browser never needs credentials for either upstream.
 * It also keeps a shared edge copy of the answers that change slowly, so many
 * readers of the same company cost the upstreams one request rather than one
 * each. See docs/providers.md in the main repository for the full architecture.
 */

interface Env {
  SEC_USER_AGENT: string;
}

enum HttpStatus {
  Ok = 200,
  BadRequest = 400,
  NotFound = 404,
  BadGateway = 502,
}

enum SessionRefresh {
  UseCached,
  Force,
}

const DESKTOP_USER_AGENT = "Mozilla/5.0";
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_CRUMB_LENGTH = 128;
const UPSTREAM_TIMEOUT_MS = 25_000;
// Upstream statuses that a fresh cookie and crumb can fix: 401/403, plus
// Yahoo's nonstandard 999 ("unusual traffic", returned for a stale session).
const YAHOO_AUTH_FAILURE_STATUSES = new Set([401, 403, 999]);

const YAHOO_COOKIE_URL = "https://fc.yahoo.com";
const YAHOO_CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
// Browser-facing path prefix -> upstream base. The trailing slash keeps
// `/yahoo/chartier` from matching the chart route.
const YAHOO_ROUTES: [prefix: string, base: string][] = [
  ["/yahoo/chart/", "https://query1.finance.yahoo.com/v8/finance/chart"],
  ["/yahoo/quoteSummary/", "https://query1.finance.yahoo.com/v10/finance/quoteSummary"],
  [
    "/yahoo/timeseries/",
    "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries",
  ],
  ["/yahoo/options/", "https://query1.finance.yahoo.com/v7/finance/options"],
];

// Mirrors yfinance-rs's validate_crumb_response (vendor/yfinance-rs/src/core/
// client/auth.rs) so a malformed or rate-limited response is never handed to
// an upstream Yahoo request as a real crumb.
const CRUMB_ERROR_PHRASES = [
  "too many requests",
  "unauthorized",
  "forbidden",
  "invalid crumb",
  "invalid credentials",
  "rate limit",
  "not found",
  "error",
];
function looksLikeInvalidCrumb(crumb: string): boolean {
  const lower = crumb.toLowerCase();
  const looksLikeHtml = crumb.includes("<") || crumb.includes(">");
  const looksLikeJson = crumb.startsWith("{") || crumb.startsWith("[");
  return (
    crumb.length === 0 ||
    crumb.length > MAX_CRUMB_LENGTH ||
    /[\s\x00-\x1f\x7f]/.test(crumb) ||
    looksLikeHtml ||
    looksLikeJson ||
    CRUMB_ERROR_PHRASES.some((phrase) => lower.includes(phrase))
  );
}

const SEC_WWW_BASE = "https://www.sec.gov";
const SEC_DATA_BASE = "https://data.sec.gov";
const SEC_PREFIX = "/sec";
const SEC_FILES_PREFIX = "/sec/files/";
const SEC_API_PREFIX = "/sec/api/";

// How long the edge may serve a copy of each route, in seconds, chosen by how
// fast the data behind it actually moves: annual statements change quarterly
// at most, the SEC's ticker file rarely, and a daily close only moves while
// the session is open. Option chains are deliberately absent — they are
// intraday quotes, priced from the current bid and ask, and a minute-old copy
// of one is a wrong answer rather than a slightly stale one.
const CACHE_TTL_SECONDS: [prefix: string, ttl: number][] = [
  ["/yahoo/chart/", 15 * 60],
  ["/yahoo/quoteSummary/", 60 * 60],
  ["/yahoo/timeseries/", 6 * 60 * 60],
  ["/sec/api/", 6 * 60 * 60],
  ["/sec/files/", 24 * 60 * 60],
];

const CACHE_STATE_HEADER = "x-proxy-cache";
type CacheState = "HIT" | "MISS" | "BYPASS";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

interface YahooSession {
  cookie: string;
  crumb: string;
  expiresAt: number;
}

// Reused across requests handled by the same isolate; a cold isolate just
// re-establishes it once. Yahoo's crumb has no fixed lifetime, so this expiry
// is a refresh cadence, not a real credential deadline.
let cachedSession: YahooSession | null = null;
// Concurrent requests that miss the cache at the same time must share one
// session fetch rather than each hitting Yahoo's login flow independently.
let sessionRequest: Promise<YahooSession> | null = null;

// A hung upstream connection must not pile up indefinitely on this isolate.
function upstreamFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
}

async function fetchYahooCookie(): Promise<string> {
  const response = await upstreamFetch(YAHOO_COOKIE_URL, {
    headers: { "user-agent": DESKTOP_USER_AGENT },
  });
  const pairs = response.headers
    .getSetCookie()
    .map((raw) => raw.split(";")[0]?.trim())
    .filter((pair): pair is string => Boolean(pair));

  if (pairs.length === 0) {
    throw new Error("No cookie received from Yahoo Finance.");
  }
  return pairs.join("; ");
}

async function fetchYahooCrumb(cookie: string): Promise<string> {
  const response = await upstreamFetch(YAHOO_CRUMB_URL, {
    headers: { cookie, "user-agent": DESKTOP_USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Yahoo crumb request failed with status ${response.status}.`);
  }

  const crumb = (await response.text()).trim();
  if (looksLikeInvalidCrumb(crumb)) {
    throw new Error("Yahoo returned an invalid crumb.");
  }
  return crumb;
}

async function establishYahooSession(): Promise<YahooSession> {
  const cookie = await fetchYahooCookie();
  const crumb = await fetchYahooCrumb(cookie);
  cachedSession = { cookie, crumb, expiresAt: Date.now() + SESSION_TTL_MS };
  return cachedSession;
}

// `stale` is the session an upstream request was just rejected for. The
// dashboard asks for its statements, profile and prices all at once, so a
// whole fan of requests can be rejected for the same expired session; each one
// that arrives after another has already replaced it takes the new session
// instead of establishing one more. Overlapping refreshes still share the one
// in-flight handshake below.
async function getYahooSession(
  refresh: SessionRefresh,
  stale?: YahooSession,
): Promise<YahooSession> {
  const replaced = stale !== undefined && cachedSession?.crumb !== stale.crumb;
  const cached =
    refresh === SessionRefresh.UseCached || replaced ? cachedSession : null;
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  sessionRequest ??= establishYahooSession().finally(() => {
    sessionRequest = null;
  });
  return sessionRequest;
}

async function requestYahoo(
  upstream: string,
  search: string,
  session: YahooSession,
): Promise<Response> {
  const url = new URL(upstream);
  // Whatever crumb the browser sent is a placeholder; only the session's is real.
  const params = new URLSearchParams(search);
  params.set("crumb", session.crumb);
  url.search = params.toString();

  return upstreamFetch(url, {
    headers: { cookie: session.cookie, "user-agent": DESKTOP_USER_AGENT },
  });
}

// A stale cached crumb fails once upstream; refresh the session and retry
// exactly once rather than propagating a fixable auth error to the browser.
async function fetchYahoo(upstream: string, search: string): Promise<Response> {
  const session = await getYahooSession(SessionRefresh.UseCached);
  const first = await requestYahoo(upstream, search, session);
  if (!YAHOO_AUTH_FAILURE_STATUSES.has(first.status)) {
    return first;
  }

  const refreshed = await getYahooSession(SessionRefresh.Force, session);
  return requestYahoo(upstream, search, refreshed);
}

function yahooUpstreamUrl(pathname: string): string | null {
  for (const [prefix, base] of YAHOO_ROUTES) {
    if (pathname.startsWith(prefix)) {
      // Keep the prefix's trailing slash: "/yahoo/chart/AAPL" -> base + "/AAPL".
      return base + pathname.slice(prefix.length - 1);
    }
  }
  return null;
}

function secUpstreamUrl(pathname: string): URL | null {
  if (pathname.startsWith(SEC_FILES_PREFIX)) {
    return new URL(SEC_WWW_BASE + pathname.slice(SEC_PREFIX.length));
  }
  if (pathname.startsWith(SEC_API_PREFIX)) {
    return new URL(SEC_DATA_BASE + pathname.slice(SEC_PREFIX.length));
  }
  return null;
}

async function proxySec(url: URL, env: Env): Promise<Response> {
  if (!env.SEC_USER_AGENT || !env.SEC_USER_AGENT.includes("@")) {
    throw new Error("Worker is missing a valid SEC_USER_AGENT secret.");
  }
  return upstreamFetch(url, { headers: { "user-agent": env.SEC_USER_AGENT } });
}

function cacheTtl(pathname: string): number | null {
  for (const [prefix, ttl] of CACHE_TTL_SECONDS) {
    if (pathname.startsWith(prefix)) {
      return ttl;
    }
  }
  return null;
}

// The Cache API is a Workers global; under plain Node (the test runner) there
// is none, and the proxy simply forwards every request.
function edgeCache(): Cache | null {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
}

// What was asked for, not who asked: the crumb a client sends is a placeholder
// the Worker replaces upstream, and the real one changes with every session
// refresh, so keying on it would split the cache by session rather than by
// question. Parameters are sorted so two spellings of one request agree.
function cacheKey(url: URL): Request {
  const key = new URL(url.origin + url.pathname);
  const params = new URLSearchParams(url.search);
  params.delete("crumb");
  params.sort();
  key.search = params.toString();
  return new Request(key, { method: "GET" });
}

// A client that asks for a fresh copy the standard way gets one, and its
// answer replaces what the edge was holding.
function asksForFresh(request: Request): boolean {
  const control = (request.headers.get("cache-control") ?? "").toLowerCase();
  const pragma = (request.headers.get("pragma") ?? "").toLowerCase();
  return (
    control.includes("no-cache") ||
    control.includes("no-store") ||
    pragma.includes("no-cache")
  );
}

function jsonError(status: HttpStatus, message: string): Response {
  return Response.json({ error: message }, { status });
}

// The Fetch spec forbids a body on these statuses; the Response constructor
// throws if one is passed regardless of whether it is actually empty.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

// Upstream cookies must never reach the browser; every other upstream header
// passes through. fetch() already transparently decompressed the body if
// Yahoo/SEC sent one gzip/br-encoded, but content-encoding and content-length
// still describe the original compressed bytes; forwarding them unchanged
// would tell the browser to decompress an already-decompressed body.
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("content-encoding");
  headers.delete("content-length");
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  const body = NULL_BODY_STATUSES.has(response.status) ? null : response.body;
  return new Response(body, { status: response.status, headers });
}

// The copy the edge keeps is the only one that carries a freshness rule: the
// Cache API reads this header to decide how long it may answer with it.
function storable(response: Response, ttl: number): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", `public, max-age=${ttl}`);
  return new Response(response.body, { status: response.status, headers });
}

// The copy the browser gets is never cached in the browser, whatever the edge
// is holding. Refresh data and Refresh price are the user's way of asking for
// something newer, and a browser-held copy would answer them with the bytes
// they already had, without the Worker ever hearing about it.
function served(response: Response, state: CacheState | null): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  if (state) {
    headers.set(CACHE_STATE_HEADER, state);
  }
  const body = NULL_BODY_STATUSES.has(response.status) ? null : response.body;
  return new Response(body, { status: response.status, headers });
}

async function route(url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }

  const yahooUpstream = yahooUpstreamUrl(url.pathname);
  if (yahooUpstream) {
    return fetchYahoo(yahooUpstream, url.search);
  }

  const sec = secUpstreamUrl(url.pathname);
  if (sec) {
    return proxySec(sec, env);
  }

  return jsonError(HttpStatus.NotFound, "Unknown route.");
}

// A route with a TTL is answered from the edge when a copy is there, and the
// upstream answer is put back for the next reader. A cache that misbehaves is
// never allowed to fail a request that the upstream could still answer, so
// both halves fall through on error.
async function cached(
  request: Request,
  url: URL,
  env: Env,
  ttl: number,
  ctx: ExecutionContext | undefined,
): Promise<Response> {
  const cache = edgeCache();
  if (!cache) {
    return served(withCors(await route(url, env)), null);
  }

  const key = cacheKey(url);
  const fresh = asksForFresh(request);
  if (!fresh) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      return served(hit, "HIT");
    }
  }

  const response = withCors(await route(url, env));
  if (response.status === HttpStatus.Ok) {
    const stored = cache
      .put(key, storable(response.clone(), ttl))
      .catch(() => undefined);
    if (ctx) {
      ctx.waitUntil(stored);
    } else {
      await stored;
    }
  }
  return served(response, fresh ? "BYPASS" : "MISS");
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return served(withCors(new Response(null, { status: HttpStatus.Ok })), null);
    }

    if (request.method !== "GET") {
      return served(
        withCors(jsonError(HttpStatus.BadRequest, "Only GET requests are supported.")),
        null,
      );
    }

    try {
      const url = new URL(request.url);
      const ttl = cacheTtl(url.pathname);
      if (ttl !== null) {
        return await cached(request, url, env, ttl, ctx);
      }
      return served(withCors(await route(url, env)), null);
    } catch {
      const failed = jsonError(HttpStatus.BadGateway, "Upstream request failed.");
      return served(withCors(failed), null);
    }
  },
};
