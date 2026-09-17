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
