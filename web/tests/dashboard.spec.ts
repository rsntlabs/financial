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
async function stub(page: Page, calls: string[] = []) {
  await page.route(API, (route) => {
    const url = new URL(route.request().url());
    const fn = url.searchParams.get("function")!;
    calls.push(fn);
    expect(url.searchParams.get("apikey")).toBe(KEY);
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
  expect(calls).toHaveLength(4);
  await page.getByLabel("Number of fiscal years").selectOption("10");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  expect(calls).toHaveLength(4);
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
  expect(calls).toHaveLength(8);
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
  expect(calls).toHaveLength(12);
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
  expect(resumed).toEqual(["BALANCE_SHEET", "CASH_FLOW", "OVERVIEW"]);
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
    expect(calls).toHaveLength(4);
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
  expect(calls).toHaveLength(4);
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
    expect(calls).toHaveLength(7);
    await page.reload();
    await search(page);
    expect(calls).toHaveLength(7);
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
    expect(total).toBe(7);
    await page.reload();
    await search(page);
    expect(total).toBe(7);
  });
}
