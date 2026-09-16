import { test, expect, chromium, type Page } from "@playwright/test";
const API = "https://www.alphavantage.co/query?*";
const KEY = "TESTKEY123";
const fields = {
  INCOME_STATEMENT: {
    totalRevenue: 100e6,
    netIncome: 10e6,
    costOfRevenue: 40e6,
    grossProfit: 60e6,
  },
  BALANCE_SHEET: {
    propertyPlantEquipment: 150e6,
    accumulatedDepreciationAmortizationPPE: 50e6,
    totalAssets: 300e6,
    totalLiabilities: 100e6,
  },
  CASH_FLOW: {
    capitalExpenditures: 20e6,
    depreciationDepletionAndAmortization: 10e6,
    operatingCashflow: 30e6,
  },
};
function fixture(fn: string, symbol = "TEST") {
  if (fn === "TIME_SERIES_DAILY") return priceFixture(symbol);
  if (fn === "OVERVIEW") return { Symbol: symbol, Name: "Test Industries" };
  return {
    symbol,
    annualReports: [2021, 2022, 2023, 2024, 2025].map((y) => ({
      fiscalDateEnding: `${y}-12-31`,
      reportedCurrency: "USD",
      ...Object.fromEntries(
        Object.entries(fields[fn as keyof typeof fields]).map(
          ([key, value]) => [
            key,
            String(
              key === "netIncome" && y === 2023 ? -5e6 : value * (y - 2020),
            ),
          ],
        ),
      ),
    })),
  };
}
function priceFixture(symbol = "TEST") {
  // Reverse chronological, as returned by the provider, spanning four months.
  return {
    "Meta Data": { "2. Symbol": symbol },
    "Time Series (Daily)": {
      "2026-09-15": { "4. close": "126.0000" },
      "2026-09-14": { "4. close": "120.0000" },
      "2026-09-01": { "4. close": "115.0000" },
      "2026-08-14": { "4. close": "110.0000" },
      "2026-06-16": { "4. close": "105.0000" },
      "2026-05-15": { "4. close": "100.0000" },
    },
  };
}
async function stub(page: Page, calls: string[] = []) {
  await page.route(API, (route) => {
    const url = new URL(route.request().url());
    const fn = url.searchParams.get("function")!;
    calls.push(fn);
    expect(url.searchParams.get("apikey")).toBe(KEY);
    expect(url.searchParams.get("outputsize")).toBe(
      fn === "TIME_SERIES_DAILY" ? "full" : null,
    );
    return route.fulfill({
      json: fixture(fn, url.searchParams.get("symbol")!),
    });
  });
}
async function setup(page: Page, remember = false) {
  await expect(
    page.getByRole("heading", { name: "Set up Alpha Vantage" }),
  ).toBeVisible();
  await page.getByLabel("Alpha Vantage API key", { exact: true }).fill(KEY);
  if (remember) await page.getByLabel("Remember my key on this device").check();
  await page.getByRole("button", { name: "Save API key", exact: true }).click();
  await expect(page.getByText(/Key saved/)).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
}
async function search(page: Page, symbol = "TEST") {
  await page.getByLabel("Ticker symbol", { exact: true }).fill(symbol);
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(
    page.getByRole("heading", { name: "Test Industries", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole("button", { name: "Refresh price", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
}
test("setup and actual WASM render annual figures, statement views, CSV and neutral layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls: string[] = [];
  await stub(page, calls);
  await page.goto("./");
  await page.screenshot({ path: "test-results/setup.png", fullPage: true });
  await setup(page);
  await search(page);
  expect(calls).toEqual([
    "INCOME_STATEMENT",
    "BALANCE_SHEET",
    "CASH_FLOW",
    "OVERVIEW",
    "TIME_SERIES_DAILY",
  ]);
  await expect(page.locator(".metric-highlight .metric-value")).toHaveText(
    "500.0M",
  );
  await expect(
    page.getByRole("img", {
      name: "Revenue, fiscal years 2021 to 2025",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Revenue breakdown not provided")).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard.png", fullPage: true });
  await page
    .getByRole("tab", { name: "Income statement", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "-5.0", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "% of Revenue", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "60.0%", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("tab", { name: "% Change YoY", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "100.0%", exact: true }).first(),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe("TEST_financials.csv");
  expect(errors).toEqual([]);
});
test("IndexedDB survives reload and new tabs; saved stocks and periods make no API calls without a key", async ({
  page,
  context,
}) => {
  const calls: string[] = [];
  await stub(page, calls);
  await page.goto("./");
  await setup(page);
  await search(page);
  await page.reload();
  await search(page);
  await expect(page.getByText(/No API requests used/)).toBeVisible();
  expect(calls).toHaveLength(5);
  await page.getByLabel("Number of fiscal years").selectOption("10");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  expect(calls).toHaveLength(5);
  const tab = await context.newPage();
  const more: string[] = [];
  await stub(tab, more);
  await tab.goto("./");
  await tab.getByRole("button", { name: "Close settings" }).click();
  await search(tab);
  expect(more).toHaveLength(0);
  await tab.getByRole("button", { name: "Refresh data", exact: true }).click();
  await expect(tab.getByRole("alert")).toContainText("API key");
  expect(more).toHaveLength(0);
  // The key is never in IndexedDB or the default persistent key store.
  const saved = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("financials-alphavantage-v1");
      r.onsuccess = () => resolve(r.result);
    });
    const values = await new Promise<unknown>((resolve) => {
      const r = db.transaction("stocks").objectStore("stocks").getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return {
      values: JSON.stringify(values),
      key: localStorage.getItem("financials.alphavantage.key"),
    };
  });
  expect(saved.values).not.toContain(KEY);
  expect(saved.key).toBeNull();
});
test("explicit refresh updates saved data; failed refresh preserves old snapshot; clearing cache requires new calls", async ({
  page,
}) => {
  const calls: string[] = [];
  await stub(page, calls);
  await page.goto("./");
  await setup(page);
  await search(page);
  await page.getByRole("button", { name: "Refresh data", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh data", exact: true }),
  ).toBeEnabled();
  expect(calls).toHaveLength(9);
  await page.unroute(API);
  await page.route(API, (route) =>
    route.fulfill({ json: { Information: "API rate limit reached" } }),
  );
  await page.getByRole("button", { name: "Refresh data", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("request limit", {
    timeout: 15000,
  });
  await page.reload();
  await search(page);
  await expect(page.getByText(/No API requests used/)).toBeVisible();
  await page.getByRole("button", { name: "Data settings" }).click();
  await page.getByRole("button", { name: "Clear saved statements" }).click();
  await page.getByRole("button", { name: "Remove saved statements" }).click();
  await expect(page.getByText("No stocks saved yet.")).toBeVisible();
  await page.unroute(API);
  await stub(page, calls);
  await page.reload();
  await search(page);
  expect(calls).toHaveLength(14);
});
test("invalid keys, unavailable symbols and malformed reports are not cached; interrupted downloads resume", async ({
  page,
}) => {
  await page.route(API, (route) =>
    route.fulfill({ json: { "Error Message": "Invalid API key" } }),
  );
  await page.goto("./");
  await setup(page);
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(page.getByRole("alert")).toContainText("rejected");
  await page.unroute(API);
  const calls: string[] = [];
  await page.route(API, (route) => {
    const fn = new URL(route.request().url()).searchParams.get("function")!;
    calls.push(fn);
    return route.fulfill({
      json: fn === "BALANCE_SHEET" ? { Note: "request limit" } : fixture(fn),
    });
  });
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(page.getByRole("alert")).toContainText("request limit", {
    timeout: 15000,
  });
  expect(calls).toEqual([
    "INCOME_STATEMENT",
    ...Array(4).fill("BALANCE_SHEET"),
  ]);
  await page.unroute(API);
  const resumed: string[] = [];
  await stub(page, resumed);
  await page.reload();
  await search(page);
  expect(resumed).toEqual([
    "BALANCE_SHEET",
    "CASH_FLOW",
    "OVERVIEW",
    "TIME_SERIES_DAILY",
  ]);
  await page.getByRole("button", { name: "Financials home" }).click();
  await page.unroute(API);
  await page.route(API, (route) =>
    route.fulfill({
      json: {
        symbol: "BAD",
        annualReports: [
          { fiscalDateEnding: "2025-12-31", totalRevenue: "None" },
        ],
      },
    }),
  );
  await page.getByLabel("Ticker symbol", { exact: true }).fill("BAD");
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(page.getByRole("alert")).toContainText("malformed");
  await expect(page.locator(".metric-grid")).toHaveCount(0);
});
test("remembered key is optional and can be forgotten; mobile settings and charts fit", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stub(page);
  await page.goto("./");
  await setup(page, true);
  await search(page);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await page
    .locator(".stock-price-panel")
    .screenshot({ path: "test-results/stock-price-mobile.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const tab = await context.newPage();
  await tab.goto("./");
  await expect(
    tab.getByRole("heading", { name: "Set up Alpha Vantage" }),
  ).toHaveCount(0);
  await tab.getByRole("button", { name: "Data settings" }).click();
  await tab.getByRole("button", { name: "Forget API key" }).click();
  expect(
    await tab.evaluate(() =>
      localStorage.getItem("financials.alphavantage.key"),
    ),
  ).toBeNull();
  await expect(
    tab.getByRole("button", { name: "TEST", exact: true }),
  ).toBeVisible();
});

test("disk cache survives an actual browser restart without a key", async ({
  baseURL,
}, testInfo) => {
  const profile = testInfo.outputPath("browser-profile");
  let context = await chromium.launchPersistentContext(profile, {
    headless: true,
    baseURL,
  });
  let page = await context.newPage();
  const calls: string[] = [];
  await stub(page, calls);
  await page.goto("./");
  await setup(page);
  await search(page);
  await page.evaluate(() => sessionStorage.clear());
  await context.close();
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    baseURL,
  });
  try {
    page = await context.newPage();
    const after: string[] = [];
    await stub(page, after);
    await page.goto("./");
    await page.getByRole("button", { name: "Close settings" }).click();
    await search(page);
    await expect(page.getByText(/No API requests used/)).toBeVisible();
    expect(after).toHaveLength(0);
    expect(calls).toHaveLength(5);
  } finally {
    await context.close();
  }
});

test("simultaneous first searches in separate tabs download the stock once", async ({
  page,
  context,
}) => {
  const calls: string[] = [];
  await stub(page, calls);
  await page.goto("./");
  await setup(page, true);
  const second = await context.newPage();
  await stub(second, calls);
  await second.goto("./");
  await Promise.all([search(page), search(second)]);
  expect(calls).toHaveLength(5);
});

for (const failure of ["network", "server"]) {
  test(`retries a temporary ${failure} failure up to three times, then caches the result`, async ({
    page,
  }) => {
    const calls: string[] = [];
    let incomeAttempts = 0;
    await page.route(API, (route) => {
      const fn = new URL(route.request().url()).searchParams.get("function")!;
      calls.push(fn);
      if (fn === "INCOME_STATEMENT" && ++incomeAttempts <= 3) {
        return failure === "network"
          ? route.abort("failed")
          : route.fulfill({ status: 503, body: "Unavailable" });
      }
      return route.fulfill({ json: fixture(fn) });
    });
    await page.goto("./");
    await setup(page);
    await search(page);
    expect(incomeAttempts).toBe(4);
    expect(calls).toHaveLength(8);
    await page.reload();
    await search(page);
    expect(calls).toHaveLength(8);
  });
}

test("stops after three retries when the server stays unavailable", async ({
  page,
}) => {
  let attempts = 0;
  await page.route(API, (route) => {
    attempts++;
    return route.fulfill({ status: 503, body: "Unavailable" });
  });
  await page.goto("./");
  await setup(page);
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "after 3 automatic retries",
    { timeout: 15000 },
  );
  expect(attempts).toBe(4);
  await expect(page.locator(".metric-grid")).toHaveCount(0);
});

for (const status of [401, 429]) {
  test(`HTTP ${status} uses the expected retry policy`, async ({ page }) => {
    let attempts = 0;
    await page.route(API, (route) => {
      attempts++;
      return route.fulfill({ status, body: "Rejected" });
    });
    await page.goto("./");
    await setup(page);
    await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
    await page.getByRole("button", { name: "Explore financials" }).click();
    await expect(page.getByRole("alert")).toContainText(
      status === 429 ? "after 3 automatic retries" : "rejected",
      { timeout: 15000 },
    );
    expect(attempts).toBe(status === 429 ? 4 : 1);
  });
}

for (const kind of ["http", "information"]) {
  test(`recovers after three ${kind} quota responses and caches the result`, async ({
    page,
  }) => {
    let attempts = 0;
    let total = 0;
    await page.route(API, (route) => {
      const fn = new URL(route.request().url()).searchParams.get("function")!;
      total++;
      if (fn === "INCOME_STATEMENT" && ++attempts <= 3) {
        return kind === "http"
          ? route.fulfill({ status: 429, body: "Too Many Requests" })
          : route.fulfill({ json: { Information: "API quota exceeded" } });
      }
      return route.fulfill({ json: fixture(fn) });
    });
    await page.goto("./");
    await setup(page);
    await search(page);
    expect(attempts).toBe(4);
    expect(total).toBe(8);
    await page.reload();
    await search(page);
    expect(total).toBe(8);
  });
}

test("price chart shows the latest close and daily change, filters locally, and supports keyboard tooltips", async ({
  page,
}) => {
  const calls: string[] = [];
  await stub(page, calls);
  await page.goto("./");
  await setup(page);
  await search(page);
  const panel = page.getByRole("region", { name: "TEST stock price" });
  await expect(panel.locator(".price-value")).toHaveText("126.00");
  await expect(
    panel.getByText("+6.00 (+5.00%) vs previous close"),
  ).toBeVisible();
  await expect(panel.getByText(/As of Sep 15, 2026/)).toBeVisible();
  await expect(panel.getByText(/Not real-time/)).toBeVisible();
  const chart = panel.getByRole("img");
  await expect(chart).toHaveAttribute(
    "aria-label",
    /2026-09-01 to 2026-09-15, 3 trading sessions/,
  );
  await expect(chart.locator(".recharts-line-curve")).toHaveAttribute(
    "d",
    /M.+L/,
  );
  await panel.getByRole("button", { name: "3M", exact: true }).click();
  await expect(chart).toHaveAttribute(
    "aria-label",
    /2026-06-16 to 2026-09-15, 5 trading sessions/,
  );
  await panel.getByRole("button", { name: "All", exact: true }).click();
  await expect(chart).toHaveAttribute(
    "aria-label",
    /2026-05-15 to 2026-09-15, 6 trading sessions/,
  );
  await expect(
    panel.getByRole("button", { name: "All", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await chart.locator(".recharts-surface").focus();
  await page.keyboard.press("ArrowRight");
  await expect(panel.locator(".recharts-tooltip-wrapper")).toContainText(
    "Close",
  );
  await expect(panel.locator(".recharts-tooltip-wrapper")).toContainText(
    "105.00",
  );
  await page.keyboard.press("ArrowLeft");
  await expect(panel.locator(".recharts-tooltip-wrapper")).toContainText(
    "May 15, 2026Close100.00",
  );
  await page.getByLabel("Number of fiscal years").selectOption("10");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(chart).toHaveAttribute("aria-label", /6 trading sessions/);
  expect(calls).toHaveLength(5);
});

test("refreshing prices updates only prices and preserves the chart and cache on failure", async ({
  page,
}) => {
  await stub(page);
  await page.goto("./");
  await setup(page);
  await search(page);
  await page.unroute(API);
  const requests: string[] = [];
  await page.route(API, (route) => {
    requests.push(new URL(route.request().url()).searchParams.get("function")!);
    const prices = priceFixture();
    prices["Time Series (Daily)"]["2026-09-15"]["4. close"] = "114.0000";
    return route.fulfill({ json: prices });
  });
  await page
    .getByRole("button", { name: "Refresh price", exact: true })
    .click();
  await expect(page.locator(".price-value")).toHaveText("114.00");
  await expect(page.getByText("-6.00 (-5.00%) vs previous close")).toHaveClass(
    "negative",
  );
  expect(requests).toEqual(["TIME_SERIES_DAILY"]);
  await page.unroute(API);
  let attempts = 0;
  await page.route(API, (route) => {
    attempts++;
    return route.fulfill({ json: { Note: "request limit" } });
  });
  await page
    .getByRole("button", { name: "Refresh price", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Showing previous prices.",
    {
      timeout: 15000,
    },
  );
  expect(attempts).toBe(4);
  await expect(page.locator(".price-value")).toHaveText("114.00");
  await page.reload();
  await search(page);
  await expect(page.locator(".price-value")).toHaveText("114.00");
  await expect(page.getByText(/Saved prices/)).toBeVisible();
  expect(attempts).toBe(4);
});

for (const kind of [
  "empty",
  "symbol",
  "number",
  "date",
  "compact",
  "premium",
]) {
  test(`unavailable or malformed ${kind} prices leave statements usable and can be retried`, async ({
    page,
  }) => {
    await page.route(API, (route) => {
      const fn = new URL(route.request().url()).searchParams.get("function")!;
      if (fn !== "TIME_SERIES_DAILY")
        return route.fulfill({ json: fixture(fn) });
      const prices = priceFixture();
      if (kind === "empty") return route.fulfill({ json: {} });
      if (kind === "premium")
        return route.fulfill({
          json: { Information: "This is a premium endpoint" },
        });
      if (kind === "compact")
        Object.assign(prices["Meta Data"], { "4. Output Size": "Compact" });
      if (kind === "symbol") prices["Meta Data"]["2. Symbol"] = "OTHER";
      if (kind === "number")
        prices["Time Series (Daily)"]["2026-09-15"]["4. close"] = "None";
      if (kind === "date")
        Object.assign(prices["Time Series (Daily)"], {
          "2026-02-30": { "4. close": "100" },
        });
      return route.fulfill({ json: prices });
    });
    await page.goto("./");
    await setup(page);
    await search(page);
    await expect(
      page.getByText("Price history unavailable", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".price-value")).toHaveCount(0);
    if (kind === "premium")
      await expect(page.getByRole("alert")).toContainText(
        "requires a premium Alpha Vantage key",
      );
    await expect(page.locator(".metric-highlight .metric-value")).toHaveText(
      "500.0M",
    );
    await page.unroute(API);
    const calls: string[] = [];
    await stub(page, calls);
    await page
      .getByRole("button", { name: "Refresh price", exact: true })
      .click();
    await expect(page.locator(".price-value")).toHaveText("126.00");
    expect(calls).toEqual(["TIME_SERIES_DAILY"]);
  });
}

test("a legacy statement cache upgrades without a key and later loads missing prices", async ({
  page,
}) => {
  await page.goto("./");
  const payload = {
    income: fixture("INCOME_STATEMENT"),
    balance: fixture("BALANCE_SHEET"),
    cashflow: fixture("CASH_FLOW"),
    overview: fixture("OVERVIEW"),
    fetchedAt: "2026-09-15T12:00:00Z",
  };
  await page.evaluate(async (payload) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("financials-alphavantage-v1");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("financials-alphavantage-v1", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("stocks", { keyPath: "ticker" });
        request.result.createObjectStore("pending", { keyPath: "ticker" });
      };
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("stocks", "readwrite");
      tx.objectStore("stocks").put({
        ticker: "TEST",
        fetchedAt: payload.fetchedAt,
        payload,
      });
      tx.oncomplete = () => resolve();
    });
    db.close();
  }, payload);
  const calls: string[] = [];
  await stub(page, calls);
  await page.reload();
  await page.getByRole("button", { name: "Close settings" }).click();
  await search(page);
  await expect(
    page.getByText("Price history unavailable", { exact: true }),
  ).toBeVisible();
  expect(calls).toEqual([]);
  await page.getByRole("button", { name: "Set up price data" }).click();
  await setup(page);
  await expect(page.locator(".price-value")).toHaveText("126.00");
  expect(calls).toEqual(["TIME_SERIES_DAILY"]);
});

test("delayed prices do not block statements or overwrite a newly selected ticker", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(API, async (route) => {
    const url = new URL(route.request().url());
    const fn = url.searchParams.get("function")!;
    const symbol = url.searchParams.get("symbol")!;
    if (fn === "TIME_SERIES_DAILY" && symbol === "TEST") await gate;
    const body = fixture(fn, symbol);
    if (fn === "TIME_SERIES_DAILY" && symbol === "NEXT") {
      (body as ReturnType<typeof priceFixture>)["Time Series (Daily)"][
        "2026-09-15"
      ]["4. close"] = "42.0000";
    }
    await route.fulfill({ json: body });
  });
  await page.goto("./");
  await setup(page);
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(
    page.getByRole("status", { name: "Loading stock prices" }),
  ).toBeVisible();
  await expect(page.locator(".metric-highlight .metric-value")).toHaveText(
    "500.0M",
  );
  await page.getByLabel("Ticker symbol", { exact: true }).fill("NEXT");
  await page.getByLabel("Ticker symbol", { exact: true }).press("Enter");
  await expect(
    page.getByRole("region", { name: "NEXT stock price" }),
  ).toBeVisible();
  await expect(page.locator(".price-value")).toHaveText("42.00");
  const oldResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.searchParams.get("function") === "TIME_SERIES_DAILY" &&
      url.searchParams.get("symbol") === "TEST"
    );
  });
  release();
  await oldResponse;
  await expect(
    page.getByRole("region", { name: "TEST stock price" }),
  ).toHaveCount(0);
  await expect(page.locator(".price-value")).toHaveText("42.00");
});

test("a single trading session shows a price marker without inventing a daily change", async ({
  page,
}) => {
  await page.route(API, (route) => {
    const fn = new URL(route.request().url()).searchParams.get("function")!;
    return route.fulfill({
      json:
        fn === "TIME_SERIES_DAILY"
          ? {
              "Meta Data": { "2. Symbol": "TEST" },
              "Time Series (Daily)": {
                "2026-09-15": { "4. close": "12.3456" },
              },
            }
          : fixture(fn),
    });
  });
  await page.goto("./");
  await setup(page);
  await search(page);
  const panel = page.getByRole("region", { name: "TEST stock price" });
  await expect(panel.locator(".price-value")).toHaveText("12.3456");
  await expect(panel.getByText("Previous close unavailable")).toBeVisible();
  await expect(panel.locator(".recharts-line-dot")).toHaveCount(1);
  await panel.getByRole("button", { name: "All", exact: true }).click();
  await expect(panel.getByRole("img")).toHaveAttribute(
    "aria-label",
    /1 trading sessions/,
  );
});

for (const scenario of ["download", "refresh", "refresh in another tab"]) {
  test(`clearing saved data invalidates a pending price ${scenario}`, async ({
    page,
    context,
  }) => {
    await stub(page);
    await page.goto("./");
    await setup(page, true);
    if (scenario !== "download") await search(page);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route(API, async (route) => {
      const fn = new URL(route.request().url()).searchParams.get("function")!;
      if (fn === "TIME_SERIES_DAILY") {
        started();
        await gate;
      }
      await route.fulfill({ json: fixture(fn) });
    });
    if (scenario === "download") {
      await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
      await page.getByRole("button", { name: "Explore financials" }).click();
    } else {
      await page
        .getByRole("button", { name: "Refresh price", exact: true })
        .click();
    }
    await pending;
    const clearingPage =
      scenario === "refresh in another tab" ? await context.newPage() : page;
    if (clearingPage !== page) await clearingPage.goto("./");
    await clearingPage.getByRole("button", { name: "Data settings" }).click();
    await clearingPage
      .getByRole("button", { name: "Clear saved statements" })
      .click();
    await clearingPage
      .getByRole("button", { name: "Remove saved statements" })
      .click();
    await expect(
      clearingPage.getByText(
        "Saved statements and prices cleared. Your API key was kept.",
      ),
    ).toBeVisible();
    release();
    await expect(
      page.getByRole("button", { name: "Refresh price", exact: true }),
    ).toBeEnabled();
    // Wait for the download's save attempt to finish before inspecting persistent state.
    const counts = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("financials-alphavantage-v1");
        request.onsuccess = () => resolve(request.result);
      });
      const counts = await Promise.all(
        ["stocks", "pending", "prices"].map(
          (name) =>
            new Promise<number>((resolve) => {
              const request = db.transaction(name).objectStore(name).count();
              request.onsuccess = () => resolve(request.result);
            }),
        ),
      );
      db.close();
      return counts;
    });
    expect(counts).toEqual([0, 0, 0]);
    await expect(
      page.getByText(
        "Prices are shown for this view only because saved data was cleared during the download.",
      ),
    ).toBeVisible();

    // Clearing invalidates old work, while a later search can save normally.
    await page.unroute(API);
    const calls: string[] = [];
    await stub(page, calls);
    await page.reload();
    await search(page);
    expect(calls).toHaveLength(5);
    await page.reload();
    await search(page);
    expect(calls).toHaveLength(5);
  });
}

function longPriceFixture(symbol = "TEST") {
  const series: Record<string, { "4. close": string }> = {};
  // Enough daily sessions to expose compact responses and accidental row limits.
  for (
    let date = new Date("1980-12-12T00:00:00Z");
    date <= new Date("2026-09-15T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
      series[date.toISOString().slice(0, 10)] = { "4. close": "100.00" };
  }
  return {
    "Meta Data": { "2. Symbol": symbol, "4. Output Size": "Full size" },
    "Time Series (Daily)": series,
  };
}

test("3Y, 5Y and All retain full history, exact calendar boundaries and cached sessions", async ({
  page,
}) => {
  const prices = longPriceFixture();
  const dates = Object.keys(prices["Time Series (Daily)"]).sort();
  let requests = 0;
  await page.route(API, (route) => {
    const url = new URL(route.request().url());
    const fn = url.searchParams.get("function")!;
    requests++;
    expect(url.searchParams.get("outputsize")).toBe(
      fn === "TIME_SERIES_DAILY" ? "full" : null,
    );
    return route.fulfill({
      json: fn === "TIME_SERIES_DAILY" ? prices : fixture(fn),
    });
  });
  await page.goto("./");
  await setup(page);
  await search(page);
  const panel = page.getByRole("region", { name: "TEST stock price" });
  for (const [range, start] of [
    ["3Y", "2023-09-15"],
    ["5Y", "2021-09-15"],
    ["All", "1980-12-12"],
  ]) {
    await panel.getByRole("button", { name: range, exact: true }).click();
    await expect(panel.getByRole("img")).toHaveAttribute(
      "aria-label",
      `TEST daily closing price, ${start} to 2026-09-15, ${dates.filter((date) => date >= start).length} trading sessions`,
    );
    await expect(
      panel.getByRole("button", { name: range, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByRole("img")).toContainText(/20[0-9]{2}/);
  }
  expect(requests).toBe(5);
  await page.reload();
  await search(page);
  await panel.getByRole("button", { name: "All", exact: true }).click();
  await expect(panel.getByRole("img")).toHaveAttribute(
    "aria-label",
    `TEST daily closing price, 1980-12-12 to 2026-09-15, ${dates.length} trading sessions`,
  );
  expect(requests).toBe(5);
});

for (const outcome of ["success", "no key", "rejected"]) {
  test(`legacy compact price cache upgrades safely: ${outcome}`, async ({
    page,
  }) => {
    await stub(page);
    await page.goto("./");
    await setup(page);
    await search(page);
    await page.evaluate(async (noKey) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("financials-alphavantage-v1");
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("prices", "readwrite");
        const store = tx.objectStore("prices");
        const request = store.get("TEST");
        request.onsuccess = () => {
          const history = request.result;
          delete history.outputSize;
          store.put(history);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      if (noKey) sessionStorage.clear();
    }, outcome === "no key");
    await page.unroute(API);
    let requests = 0;
    await page.route(API, (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("function")).toBe("TIME_SERIES_DAILY");
      expect(url.searchParams.get("outputsize")).toBe("full");
      requests++;
      return route.fulfill({
        json:
          outcome === "rejected"
            ? { Information: "This is a premium endpoint" }
            : longPriceFixture(),
      });
    });
    await page.reload();
    if (outcome === "no key")
      await page.getByRole("button", { name: "Close settings" }).click();
    await search(page);
    const panel = page.getByRole("region", { name: "TEST stock price" });
    await panel.getByRole("button", { name: "All", exact: true }).click();
    await expect(panel.getByRole("img")).toHaveAttribute(
      "aria-label",
      outcome === "success"
        ? /1980-12-12 to 2026-09-15/
        : /2026-05-15 to 2026-09-15, 6 trading sessions/,
    );
    if (outcome !== "success")
      await expect(panel.getByRole("status")).toContainText(/limited/i);
    expect(requests).toBe(outcome === "no key" ? 0 : 1);
    const outputSize = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("financials-alphavantage-v1");
        request.onsuccess = () => resolve(request.result);
      });
      const value = await new Promise<string | undefined>((resolve) => {
        const request = db
          .transaction("prices")
          .objectStore("prices")
          .get("TEST");
        request.onsuccess = () => resolve(request.result.outputSize);
      });
      db.close();
      return value;
    });
    expect(outputSize).toBe(outcome === "success" ? "full" : undefined);
  });
}
