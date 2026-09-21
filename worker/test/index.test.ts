import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ENV = { SEC_USER_AGENT: "Financials/1.0 test@example.org" };

// The Worker caches the Yahoo session in a module-level variable, so each test
// needs its own module instance, wired to its own upstream stub.
async function startWorker(fetchMock: Mock) {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  const mod = await import("../src/index");
  return mod.default;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.href;
  }
  return typeof input === "string" ? input : input.url;
}

function stubYahooSession(extra: (url: string, init?: RequestInit) => Response | undefined) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url === "https://fc.yahoo.com") {
      return new Response(null, { headers: { "set-cookie": "A=1; Path=/; HttpOnly" } });
    }
    if (url.startsWith("https://query1.finance.yahoo.com/v1/test/getcrumb")) {
      return new Response("real-crumb");
    }
    const response = extra(url, init);
    if (response) {
      return response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// A stand-in for the Workers Cache API: enough of it to tell a hit from a
// miss, and to show what the Worker decided to keep.
function stubEdgeCache() {
  const entries = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: Request) => entries.get(key.url)?.clone()),
    put: vi.fn(async (key: Request, response: Response) => {
      entries.set(key.url, response);
    }),
  };
  vi.stubGlobal("caches", { default: cache });
  return { cache, entries };
}

// Real Workers always pass one; the fallback path (no ctx) is exercised by the
// tests that leave it out. Only waitUntil is reached from here, so the rest of
// the runtime's context is not stood up.
const CTX = {
  waitUntil: (work: Promise<unknown>) => void work,
} as unknown as ExecutionContext;

// startWorker stubs the global fetch; restoreAllMocks would not undo that.
beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("/health", () => {
  it("answers without contacting any upstream", async () => {
    const fetchMock = vi.fn();
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(new Request("https://proxy.test/health"), ENV);

    expect(await response.json()).toEqual({ status: "ok" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Yahoo routes", () => {
  it("injects a real session, drops the client crumb, and strips Set-Cookie", async () => {
    const fetchMock = stubYahooSession((url) =>
      url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/AAPL")
        ? jsonResponse({ chart: {} }, { headers: { "set-cookie": "leak=1" } })
        : undefined,
    );
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL?range=max&crumb=stale"),
      ENV,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ chart: {} });

    const chartCall = fetchMock.mock.calls.find(([input]) =>
      urlOf(input).includes("/v8/finance/chart/"),
    );
    expect(chartCall).toBeTruthy();
    const [chartUrl, chartInit] = chartCall as [RequestInfo | URL, RequestInit];
    expect(urlOf(chartUrl)).toContain("crumb=real-crumb");
    expect(urlOf(chartUrl)).not.toContain("crumb=stale");
    expect(urlOf(chartUrl)).toContain("range=max");
    expect((chartInit.headers as Record<string, string>).cookie).toBe("A=1");
  });

  it("routes the option chain to Yahoo's options endpoint, keeping the expiration", async () => {
    const fetchMock = stubYahooSession((url) =>
      url.startsWith("https://query1.finance.yahoo.com/v7/finance/options/AAPL")
        ? jsonResponse({ optionChain: { result: [] } })
        : undefined,
    );
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.test/yahoo/options/AAPL?date=1771545600"),
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ optionChain: { result: [] } });
    const [optionsUrl] = fetchMock.mock.calls.find(([input]) =>
      urlOf(input).includes("/v7/finance/options/"),
    ) as [RequestInfo | URL];
    expect(urlOf(optionsUrl)).toContain("date=1771545600");
    expect(urlOf(optionsUrl)).toContain("crumb=real-crumb");
  });

  it("strips content-encoding and content-length, since fetch() already decoded the body", async () => {
    const fetchMock = stubYahooSession((url) =>
      url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/AAPL")
        ? jsonResponse(
            { chart: {} },
            { headers: { "content-encoding": "gzip", "content-length": "9999" } },
          )
        : undefined,
    );
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL"),
      ENV,
    );

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.json()).toEqual({ chart: {} });
  });

  it("retries once with a fresh session after an auth failure", async () => {
    let crumbCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url === "https://fc.yahoo.com") {
        return new Response(null, { headers: { "set-cookie": "A=1; Path=/" } });
      }
      if (url.startsWith("https://query1.finance.yahoo.com/v1/test/getcrumb")) {
        crumbCalls += 1;
        return new Response(`crumb-${crumbCalls}`);
      }
      if (url.includes("crumb=crumb-1")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.includes("crumb=crumb-2")) {
        return jsonResponse({ quoteSummary: {} });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.test/yahoo/quoteSummary/AAPL?modules=price"),
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ quoteSummary: {} });
    expect(crumbCalls).toBe(2);
  });

  it("shares one session fetch across concurrent requests that miss the cache together", async () => {
    let cookieCalls = 0;
    let crumbCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url === "https://fc.yahoo.com") {
        cookieCalls += 1;
        return new Response(null, { headers: { "set-cookie": "A=1; Path=/" } });
      }
      if (url.startsWith("https://query1.finance.yahoo.com/v1/test/getcrumb")) {
        crumbCalls += 1;
        return new Response("real-crumb");
      }
      if (url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/")) {
        return jsonResponse({ chart: {} });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const worker = await startWorker(fetchMock);

    const [a, b] = await Promise.all([
      worker.fetch(new Request("https://proxy.test/yahoo/chart/AAPL"), ENV),
      worker.fetch(new Request("https://proxy.test/yahoo/chart/MSFT"), ENV),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(cookieCalls).toBe(1);
    expect(crumbCalls).toBe(1);
  });

  it("establishes one session for a stale one, however many requests it fails", async () => {
    let crumbCalls = 0;
    let arrive!: () => void;
    const straggler = new Promise<void>((resolve) => (arrive = resolve));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url === "https://fc.yahoo.com") {
        return new Response(null, { headers: { "set-cookie": "A=1; Path=/" } });
      }
      if (url.startsWith("https://query1.finance.yahoo.com/v1/test/getcrumb")) {
        crumbCalls += 1;
        return new Response(`crumb-${crumbCalls}`);
      }
      if (url.includes("crumb=crumb-1")) {
        // MSFT is told its session is stale only after AAPL has already
        // replaced it: the straggler of a fan of parallel requests that were
        // all rejected for the same expired session.
        if (url.includes("/MSFT")) {
          await straggler;
        }
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.includes("crumb=crumb-2")) {
        return jsonResponse({ chart: {} });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const worker = await startWorker(fetchMock);

    // Both start on the same first session; only the second is held back.
    const straggling = worker.fetch(new Request("https://proxy.test/yahoo/chart/MSFT"), ENV);
    const first = await worker.fetch(new Request("https://proxy.test/yahoo/chart/AAPL"), ENV);
    arrive();
    const second = await straggling;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ chart: {} });
    expect(crumbCalls).toBe(2);
  });
});

describe("SEC routes", () => {
  it("routes company facts to data.sec.gov with the real user agent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(urlOf(input)).toBe("https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json");
      expect((init?.headers as Record<string, string>)["user-agent"]).toBe(ENV.SEC_USER_AGENT);
      return jsonResponse({ entityName: "Apple Inc." });
    });
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.test/sec/api/xbrl/companyfacts/CIK0000320193.json"),
      ENV,
    );

    expect(await response.json()).toEqual({ entityName: "Apple Inc." });
  });

  it("routes the ticker file to www.sec.gov", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(urlOf(input)).toBe("https://www.sec.gov/files/company_tickers.json");
      return jsonResponse({});
    });
    const worker = await startWorker(fetchMock);

    await worker.fetch(new Request("https://proxy.test/sec/files/company_tickers.json"), ENV);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when the SEC_USER_AGENT secret is missing or invalid", async () => {
    const fetchMock = vi.fn();
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.test/sec/files/company_tickers.json"),
      { SEC_USER_AGENT: "" },
    );

    expect(response.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("request validation", () => {
  it("rejects non-GET requests", async () => {
    const fetchMock = vi.fn();
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL", { method: "POST" }),
      ENV,
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers CORS preflight without contacting any upstream", async () => {
    const fetchMock = vi.fn();
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL", { method: "OPTIONS" }),
      ENV,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s unknown routes", async () => {
    const worker = await startWorker(vi.fn());

    const response = await worker.fetch(new Request("https://proxy.test/unknown"), ENV);

    expect(response.status).toBe(404);
  });
});

describe("edge cache", () => {
  function stubChart(body: unknown = { chart: {} }) {
    let upstreamCalls = 0;
    const fetchMock = stubYahooSession((url) => {
      if (url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/AAPL")) {
        upstreamCalls += 1;
        return jsonResponse(body);
      }
      return undefined;
    });
    return { fetchMock, calls: () => upstreamCalls };
  }

  it("answers a repeat request from the edge instead of the upstream", async () => {
    const { cache } = stubEdgeCache();
    const { fetchMock, calls } = stubChart();
    const worker = await startWorker(fetchMock);

    const first = await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL?range=max"),
      ENV,
      CTX,
    );
    const second = await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL?range=max"),
      ENV,
      CTX,
    );

    expect(first.headers.get("x-proxy-cache")).toBe("MISS");
    expect(second.headers.get("x-proxy-cache")).toBe("HIT");
    expect(await second.json()).toEqual({ chart: {} });
    expect(calls()).toBe(1);
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it("keeps the edge copy under a freshness rule, and the browser's under none", async () => {
    const { entries } = stubEdgeCache();
    const { fetchMock } = stubChart();
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL"),
      ENV,
      CTX,
    );

    // The browser must always come back to the Worker: Refresh price is the
    // user's way of asking for something newer than what they have.
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [kept] = [...entries.values()];
    expect(kept?.headers.get("cache-control")).toBe("public, max-age=900");
  });

  it("keys on the question, not the session: a stale client crumb still hits", async () => {
    const { entries } = stubEdgeCache();
    const { fetchMock, calls } = stubChart();
    const worker = await startWorker(fetchMock);

    await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL?range=max&crumb=stale"),
      ENV,
      CTX,
    );
    const second = await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL?crumb=other&range=max"),
      ENV,
      CTX,
    );

    expect(second.headers.get("x-proxy-cache")).toBe("HIT");
    expect(calls()).toBe(1);
    expect([...entries.keys()]).toEqual(["https://proxy.test/yahoo/chart/AAPL?range=max"]);
  });

  it("never caches an option chain, since those are intraday quotes", async () => {
    const { cache } = stubEdgeCache();
    let upstreamCalls = 0;
    const fetchMock = stubYahooSession((url) => {
      if (url.startsWith("https://query1.finance.yahoo.com/v7/finance/options/AAPL")) {
        upstreamCalls += 1;
        return jsonResponse({ optionChain: { result: [] } });
      }
      return undefined;
    });
    const worker = await startWorker(fetchMock);

    const first = await worker.fetch(
      new Request("https://proxy.test/yahoo/options/AAPL"),
      ENV,
      CTX,
    );
    await worker.fetch(new Request("https://proxy.test/yahoo/options/AAPL"), ENV, CTX);

    expect(upstreamCalls).toBe(2);
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(first.headers.get("x-proxy-cache")).toBeNull();
    expect(first.headers.get("cache-control")).toBe("no-store");
  });

  it("gives a client that asks for a fresh copy one, and keeps what it answered", async () => {
    const { entries } = stubEdgeCache();
    let body = { chart: { first: true } };
    const fetchMock = stubYahooSession((url) =>
      url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/AAPL")
        ? jsonResponse(body)
        : undefined,
    );
    const worker = await startWorker(fetchMock);

    await worker.fetch(new Request("https://proxy.test/yahoo/chart/AAPL"), ENV, CTX);
    body = { chart: { first: false } };
    const forced = await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL", {
        headers: { "cache-control": "no-cache" },
      }),
      ENV,
      CTX,
    );

    expect(forced.headers.get("x-proxy-cache")).toBe("BYPASS");
    expect(await forced.json()).toEqual({ chart: { first: false } });
    // The forced answer replaces what the edge was holding, so the next
    // reader is not served the copy the user just rejected.
    const next = await worker.fetch(new Request("https://proxy.test/yahoo/chart/AAPL"), ENV, CTX);
    expect(next.headers.get("x-proxy-cache")).toBe("HIT");
    expect(await next.json()).toEqual({ chart: { first: false } });
    expect(entries.size).toBe(1);
  });

  it("caches the SEC ticker file for a day and company facts for six hours", async () => {
    const { entries } = stubEdgeCache();
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const worker = await startWorker(fetchMock);

    await worker.fetch(new Request("https://proxy.test/sec/files/company_tickers.json"), ENV, CTX);
    await worker.fetch(
      new Request("https://proxy.test/sec/api/xbrl/companyfacts/CIK0000320193.json"),
      ENV,
      CTX,
    );
    const second = await worker.fetch(
      new Request("https://proxy.test/sec/files/company_tickers.json"),
      ENV,
      CTX,
    );

    expect(second.headers.get("x-proxy-cache")).toBe("HIT");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ttls = [...entries.entries()].map(([url, response]) => [
      new URL(url).pathname,
      response.headers.get("cache-control"),
    ]);
    expect(ttls).toEqual([
      ["/sec/files/company_tickers.json", "public, max-age=86400"],
      ["/sec/api/xbrl/companyfacts/CIK0000320193.json", "public, max-age=21600"],
    ]);
  });

  it("does not keep a failed upstream answer", async () => {
    const { cache } = stubEdgeCache();
    const fetchMock = stubYahooSession((url) =>
      url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/AAPL")
        ? new Response("nope", { status: 404 })
        : undefined,
    );
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.test/yahoo/chart/AAPL"),
      ENV,
      CTX,
    );

    expect(response.status).toBe(404);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("serves the upstream anyway when the cache itself fails", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => {
          throw new Error("cache unavailable");
        }),
        put: vi.fn(async () => {
          throw new Error("cache unavailable");
        }),
      },
    });
    const { fetchMock } = stubChart();
    const worker = await startWorker(fetchMock);

    const response = await worker.fetch(new Request("https://proxy.test/yahoo/chart/AAPL"), ENV);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chart: {} });
  });

  it("forwards everything untouched where there is no Cache API at all", async () => {
    const { fetchMock, calls } = stubChart();
    const worker = await startWorker(fetchMock);

    const first = await worker.fetch(new Request("https://proxy.test/yahoo/chart/AAPL"), ENV);
    await worker.fetch(new Request("https://proxy.test/yahoo/chart/AAPL"), ENV);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-proxy-cache")).toBeNull();
    expect(calls()).toBe(2);
  });
});
