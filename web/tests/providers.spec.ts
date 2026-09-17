import { test, expect, type Page } from "@playwright/test";
import {
  CHART,
  KEY,
  STATEMENTS,
  HTTP,
  UPSTREAM,
  fixture,
  stub,
  timeseries,
} from "./upstream";

async function load(page: Page, ticker = "TEST") {
  await page.goto("./");
  await page.getByLabel("Ticker symbol", { exact: true }).fill(ticker);
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(
    page.getByRole("heading", { name: "Test Industries", exact: true }),
  ).toBeVisible();
}

async function saved(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("financials-alphavantage-v1");
      request.onsuccess = () => resolve(request.result);
    });
    const stock = await new Promise<{ payload: ReturnType<typeof fixture> }>(
      (resolve) => {
        const request = db
          .transaction("stocks")
          .objectStore("stocks")
          .get("TEST");
        request.onsuccess = () => resolve(request.result);
      },
    );
    db.close();
    return stock.payload;
  });
}

function facts() {
  const annual = (value: number) =>
    [2021, 2022, 2023, 2024, 2025].map((year) => ({
      start: `${year}-01-01`,
      end: `${year}-12-31`,
      val: value,
      filed: "2026-02-01",
      form: "10-K",
      fp: "FY",
      fy: 2025,
      accn: "test",
    }));
  const concept = (values: unknown[]) => ({
    label: "",
    description: "",
    units: { USD: values },
  });
  return {
    cik: 1,
    entityName: "Test Industries",
    facts: {
      "us-gaap": {
        Revenues: concept(annual(900e6)),
        PropertyPlantAndEquipmentNet: concept(
          annual(150e6).map(({ start: _start, ...instant }) => instant),
        ),
      },
    },
  };
}

test("provider worker uses typed Yahoo statements and retries transient failures", async ({
  page,
}) => {
  await stub(page);
  const credentials: string[] = [];
  await page.exposeFunction("recordCredentials", (value: string) =>
    credentials.push(value),
  );
  await page.addInitScript(() => {
    const workerUrls: string[] = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        workerUrls.push(String(url));
        super(url, options);
      }
    };
    (window as unknown as { providerWorkerUrls: string[] }).providerWorkerUrls =
      workerUrls;
    const original = window.fetch;
    window.fetch = (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("yahoo.com")) {
        void (
          window as unknown as { recordCredentials(value: string): void }
        ).recordCredentials(request.credentials);
      }
      return original(input, init);
    };
  });
  let attempts = 0;
  const statuses = [HTTP.UNAUTHORIZED, HTTP.SERVICE_UNAVAILABLE];
  await page.route(STATEMENTS, (route) => {
    const url = new URL(route.request().url());
    // Disable supplemental rows: these figures must come from yfinance-rs parsing.
    if (url.searchParams.get("period1") === "0") {
      return route.fulfill({
        json: { timeseries: { result: [], error: null } },
      });
    }
    if (url.searchParams.get("type")!.startsWith("annualTotalRevenue")) {
      const status = statuses[attempts++];
      if (status) {
        return route.fulfill({ status, json: {} });
      }
      expect(url.searchParams.get("crumb")).toBe("test-crumb");
    }
    return route.fulfill({
      json: timeseries(fixture(), url.searchParams.get("type")!.split(",")),
    });
  });
  await load(page);
  expect(attempts).toBe(3);
  expect((await saved(page)).metrics.annualTotalRevenue["2025-12-31"]).toBe(
    500e6,
  );
  expect(credentials).toHaveLength(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { providerWorkerUrls: string[] })
          .providerWorkerUrls,
    ),
  ).toEqual([expect.stringContaining("provider.worker")]);
});

test("SEC requests run in WASM after Yahoo and preserve share classes and existing values", async ({
  page,
}) => {
  const requests: string[] = [];
  await stub(page);
  await page.route(UPSTREAM, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.hostname);
    if (url.hostname === "www.sec.gov") {
      return route.fulfill({
        json: {
          "0": { cik_str: 1, ticker: "TEST.A", title: "Test Industries" },
          "1": { cik_str: 1, ticker: "TEST", title: "Test Industries" },
        },
      });
    }
    if (url.hostname === "data.sec.gov") {
      expect(url.pathname).toBe("/api/xbrl/companyfacts/CIK0000000001.json");
      return route.fulfill({ json: facts() });
    }
    if (url.hostname === "www.alphavantage.co") {
      throw new Error("No key supplied");
    }
    return route.fallback();
  });
  await page.route(STATEMENTS, (route) => {
    const data = fixture();
    delete data.metrics.annualNetPPE;
    delete data.metrics.annualGrossPPE;
    return route.fulfill({ json: timeseries(data) });
  });
  await load(page);
  const data = await saved(page);
  expect(data.metrics.annualTotalRevenue["2025-12-31"]).toBe(500e6);
  expect(data.sources.annualTotalRevenue["2025-12-31"]).toBe("Yahoo Finance");
  expect(data.metrics.annualNetPPE["2025-12-31"]).toBe(150e6);
  expect(data.sources.annualNetPPE["2025-12-31"]).toBe("SEC EDGAR");
  expect(requests.indexOf("www.sec.gov")).toBeGreaterThan(
    requests.indexOf("query1.finance.yahoo.com"),
  );
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST.A");
  await page.getByLabel("Ticker symbol", { exact: true }).press("Enter");
  await expect
    .poll(() => requests.filter((host) => host === "data.sec.gov").length)
    .toBe(2);
  expect(requests.filter((host) => host === "www.sec.gov")).toHaveLength(1);
});

test("SEC alone supplies financials when Yahoo fails without contacting Alpha", async ({
  page,
}) => {
  await stub(page);
  await page.route(UPSTREAM, (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "www.sec.gov") {
      return route.fulfill({
        json: { "0": { cik_str: 1, ticker: "TEST", title: "Test Industries" } },
      });
    }
    if (url.hostname === "data.sec.gov") {
      return route.fulfill({ json: facts() });
    }
    expect(url.hostname).not.toBe("www.alphavantage.co");
    return route.fulfill({ status: HTTP.NOT_FOUND, json: {} });
  });
  await load(page);
  expect((await saved(page)).sources.annualTotalRevenue["2025-12-31"]).toBe(
    "SEC EDGAR",
  );
  await expect(page.getByText(/Daily prices unavailable/)).toBeVisible();
});

test("Alpha requests stay last, carry the key only to Alpha, and parse full daily history", async ({
  page,
}) => {
  const order: string[] = [];
  await stub(page, [], KEY);
  await page.route(UPSTREAM, (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "www.alphavantage.co") {
      expect(url.href).not.toContain(KEY);
      if (url.hostname.includes("sec.gov")) {
        order.push("SEC");
      }
      return route.fallback();
    }
    expect(url.searchParams.get("apikey")).toBe(KEY);
    const endpoint = url.searchParams.get("function")!;
    order.push(endpoint);
    if (endpoint === "TIME_SERIES_DAILY") {
      expect(url.searchParams.get("outputsize")).toBe("full");
      return route.fulfill({
        json: {
          "Meta Data": { "2. Symbol": "TEST", "4. Output Size": "Full size" },
          "Time Series (Daily)": { "2025-12-31": { "4. close": "123.45" } },
        },
      });
    }
    return route.fulfill({
      json: {
        symbol: "TEST",
        annualReports: [
          {
            fiscalDateEnding: "2025-12-31",
            reportedCurrency: "USD",
            shortTermDebt: "123",
          },
        ],
      },
    });
  });
  await page.route(CHART, (route) =>
    route.fulfill({ status: HTTP.NOT_FOUND, json: {} }),
  );
  await page.goto("./");
  await page.getByRole("button", { name: "Data settings" }).click();
  await page.getByLabel("Alpha Vantage API key", { exact: true }).fill(KEY);
  await page.getByRole("button", { name: "Save API key", exact: true }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(page.locator(".price-value")).toHaveText("123.45");
  expect(order[0]).toBe("SEC");
  expect(order.at(-1)).toBe("TIME_SERIES_DAILY");
  expect(order).toContain("BALANCE_SHEET");
  expect(JSON.stringify(await saved(page))).not.toContain(KEY);
});

test("WASM provider deadlines release a stalled Yahoo request and continue to SEC", async ({
  page,
}) => {
  await page.clock.install();
  await stub(page);
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(STATEMENTS, () => {
    started();
  });
  await page.route("https://www.sec.gov/**", (route) =>
    route.fulfill({
      json: { "0": { cik_str: 1, ticker: "TEST", title: "Test Industries" } },
    }),
  );
  await page.route("https://data.sec.gov/**", (route) =>
    route.fulfill({ json: facts() }),
  );
  await page.goto("./");
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
  await pending;
  const providerDeadlineMs = 75_000;
  await page.clock.fastForward(providerDeadlineMs);
  await expect(
    page.getByRole("heading", { name: "Test Industries", exact: true }),
  ).toBeVisible();
  expect((await saved(page)).sources.annualTotalRevenue["2025-12-31"]).toBe(
    "SEC EDGAR",
  );
});

test("SEC browser rate limiting and ticker caching work across concurrent WASM calls", async ({
  page,
}) => {
  await stub(page);
  await load(page);
  let tickerRequests = 0;
  let factRequests = 0;
  const count = 7; // Exceeds the client's five-request burst.
  await page.route(UPSTREAM, (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "www.sec.gov") {
      tickerRequests++;
      return route.fulfill({
        json: Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            i,
            { cik_str: i + 1, ticker: `TEST${i}`, title: "Test Industries" },
          ]),
        ),
      });
    }
    if (url.hostname === "data.sec.gov") {
      factRequests++;
      return route.fulfill({ json: facts() });
    }
    return route.fulfill({ status: HTTP.NOT_FOUND, json: {} });
  });
  const revenues = await page.evaluate(async (count) => {
    const moduleUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => /\/financial_core-[^/]+\.js$/.test(url))!;
    const engine = await import(moduleUrl);
    const providers = new engine.BrowserProviders();
    try {
      const results: string[] = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          providers.financials(`TEST${i}`, "", 5),
        ),
      );
      return results.map(
        (result) => JSON.parse(result).metrics.annualTotalRevenue["2025-12-31"],
      );
    } finally {
      providers.free();
    }
  }, count);
  expect(revenues).toEqual(Array(count).fill(900e6));
  expect(tickerRequests).toBe(1);
  expect(factRequests).toBe(count);
});
