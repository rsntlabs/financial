import { test, expect, type Page } from "@playwright/test";
import {
  HTTP,
  STATEMENTS,
  CHART,
  KEY,
  fixture,
  priceFixture,
  fulfillChart,
  stub,
} from "./upstream";
async function setup(page: Page, remember = false) {
  await page.getByRole("button", { name: "Data settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Optional Alpha Vantage fallback" }),
  ).toBeVisible();
  await page.getByLabel("Alpha Vantage API key", { exact: true }).fill(KEY);
  if (remember) await page.getByLabel("Remember my key on this device").check();
  await page.getByRole("button", { name: "Save API key", exact: true }).click();
  await expect(page.getByText(/Key saved/)).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
}
async function search(page: Page, symbol = "TEST") {
  await page.getByLabel("Ticker symbol", { exact: true }).fill(symbol);
  await page.getByLabel("Ticker symbol", { exact: true }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "Test Industries", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole("button", { name: "Refresh price", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
}
test("keyless provider API and WASM analysis render annual figures, statement views, CSV and neutral layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls: string[] = [];
  await stub(page, calls);
  await page.goto("./");
  await page.screenshot({ path: "test-results/setup.png", fullPage: true });
  await search(page);
  expect(calls).toEqual(["financials", "prices"]);
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
test("price chart shows the latest close and daily change, filters locally, and supports keyboard tooltips", async ({
  page,
}) => {
  const calls: string[] = [];
  await stub(page, calls);
  await page.goto("./");
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
  expect(calls).toHaveLength(2);
});

test("cache survives reload and another tab, and period changes make no requests", async ({
  page,
  context,
}) => {
  const calls: string[] = [];
  await stub(page, calls);
  await page.goto("./");
  await search(page);
  await page.reload();
  await search(page);
  await expect(page.getByText(/No API requests used/)).toBeVisible();
  await page.getByLabel("Number of fiscal years").selectOption("10");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  expect(calls).toEqual(["financials", "prices"]);
  const tab = await context.newPage();
  const more: string[] = [];
  await stub(tab, more);
  await tab.goto("./");
  await search(tab);
  expect(more).toHaveLength(0);
  await tab.getByRole("button", { name: "Refresh data", exact: true }).click();
  await expect(
    tab.getByRole("button", { name: "Refresh data", exact: true }),
  ).toBeEnabled();
  expect(more).toEqual(["financials"]);
});

test("optional keys go only to Alpha Vantage, are not cached with data, and can be forgotten", async ({
  page,
}) => {
  await stub(page, [], KEY);
  await page.goto("./");
  await setup(page, true);
  await search(page);
  const cached = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open("financials-alphavantage-v1");
      q.onsuccess = () => r(q.result);
    });
    const rows = await new Promise<unknown>((r) => {
      const q = db.transaction("stocks").objectStore("stocks").getAll();
      q.onsuccess = () => r(q.result);
    });
    db.close();
    return JSON.stringify(rows);
  });
  expect(cached).not.toContain(KEY);
  expect(cached).toContain("Yahoo Finance");
  await page.getByRole("button", { name: "Data settings" }).click();
  await page.getByRole("button", { name: "Forget API key" }).click();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("financials.alphavantage.key"),
    ),
  ).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("failed financial and price refreshes retain the saved snapshot", async ({
  page,
}) => {
  await stub(page);
  await page.goto("./");
  await search(page);
  await page.unroute("**/api/*");
  await page.route("**/api/*", (r) =>
    r.fulfill({ status: HTTP.NOT_FOUND, json: {} }),
  );
  await page
    .getByRole("button", { name: "Refresh price", exact: true })
    .click();
  await expect(page.getByText(/Daily prices unavailable/)).toBeVisible();
  await expect(page.locator(".price-value")).toHaveText("126.00");
  await page.getByRole("button", { name: "Refresh data", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "provider service could not complete the request",
  );
  await page.reload();
  await search(page);
  await expect(page.getByText(/No API requests used/)).toBeVisible();
});

for (const scenario of ["download", "refresh", "refresh in another tab"]) {
  test(`cache clearing invalidates pending price ${scenario}`, async ({
    page,
    context,
  }) => {
    await stub(page);
    await page.goto("./");
    if (scenario !== "download") await search(page);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending = new Promise<void>((r) => (started = r));
    await page.route(CHART, async (r) => {
      started();
      await gate;
      await fulfillChart(r);
    });
    if (scenario === "download") {
      await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
      await page.getByRole("button", { name: "Explore financials" }).click();
    } else
      await page
        .getByRole("button", { name: "Refresh price", exact: true })
        .click();
    await pending;
    const clearing =
      scenario === "refresh in another tab" ? await context.newPage() : page;
    if (clearing !== page) await clearing.goto("./");
    await clearing.getByRole("button", { name: "Data settings" }).click();
    await clearing
      .getByRole("button", { name: "Clear saved statements" })
      .click();
    await clearing
      .getByRole("button", { name: "Remove saved statements" })
      .click();
    await expect(clearing.getByText("No stocks saved yet.")).toBeVisible();
    release();
    await expect(
      page.getByText(
        "Prices are shown for this view only because saved data was cleared during the download.",
      ),
    ).toBeVisible();
    const count = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((r) => {
        const q = indexedDB.open("financials-alphavantage-v1");
        q.onsuccess = () => r(q.result);
      });
      const n = await new Promise<number>((r) => {
        const q = db.transaction("prices").objectStore("prices").count();
        q.onsuccess = () => r(q.result);
      });
      db.close();
      return n;
    });
    expect(count).toBe(0);
  });
}

test("missing data is a gap, empty upstream responses are not saved", async ({
  page,
}) => {
  await stub(page);
  await page.route(STATEMENTS, (r) =>
    r.fulfill({
      json: {
        schemaVersion: 1,
        metrics: {},
        sources: {},
        fetchedAt: "2026-09-16T00:00:00Z",
      },
    }),
  );
  await page.goto("./");
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "No annual revenue available",
  );
  await page.unroute(STATEMENTS);
  const data = fixture();
  delete data.metrics.annualNetIncome;
  await page.route(STATEMENTS, (r) => r.fulfill({ json: data }));
  await search(page);
  await page.locator("summary").click();
  await expect(page.getByText(/FY 2025: net income unavailable/)).toBeVisible();
});

test("prices load separately and stale ticker responses cannot replace the current view", async ({
  page,
}) => {
  await stub(page);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const pending = new Promise<void>((r) => (started = r));
  await page.route(CHART, async (r) => {
    const ticker = new URL(r.request().url()).pathname.split("/").at(-1)!;
    if (ticker === "TEST") {
      started();
      await gate;
    }
    await fulfillChart(r, priceFixture(ticker));
  });
  await page.goto("./");
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
  await pending;
  await expect(
    page.getByRole("heading", { name: "Test Industries", exact: true }),
  ).toBeVisible();
  await search(page, "NEXT");
  release();
  await expect(
    page.getByRole("region", { name: "NEXT stock price" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "TEST stock price" }),
  ).toHaveCount(0);
});

test("all available price history is preserved and calendar controls stay local", async ({
  page,
}) => {
  const prices = priceFixture();
  prices.points = [];
  for (
    let date = new Date("1980-12-12T00:00:00Z");
    date <= new Date("2026-09-15T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
      prices.points.push({ date: date.toISOString().slice(0, 10), close: 100 });
  }
  const calls: string[] = [];
  await stub(page, calls);
  await page.route(CHART, (r) => fulfillChart(r, prices));
  await page.goto("./");
  await search(page);
  const panel = page.getByRole("region", { name: "TEST stock price" });
  for (const [label, start] of [
    ["3Y", "2023-09-15"],
    ["5Y", "2021-09-15"],
    ["All", "1980-12-12"],
  ]) {
    await panel.getByRole("button", { name: label, exact: true }).click();
    await expect(panel.getByRole("img")).toHaveAttribute(
      "aria-label",
      new RegExp(`${start} to 2026-09-15`),
    );
  }
  expect(calls).toEqual(["financials"]);
});

test("legacy Alpha statements open without a key while prices use the new provider chain", async ({
  page,
}) => {
  const calls: string[] = [];
  await stub(page, calls);
  await page.goto("./");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open("financials-alphavantage-v1", 2);
      q.onupgradeneeded = () => {
        for (const store of ["stocks", "pending", "prices"])
          q.result.createObjectStore(store, { keyPath: "ticker" });
      };
      q.onsuccess = () => r(q.result);
    });
    await new Promise<void>((r) => {
      const tx = db.transaction("stocks", "readwrite");
      tx.objectStore("stocks").put({
        ticker: "TEST",
        fetchedAt: "2025-12-31",
        payload: {
          fetchedAt: "2025-12-31",
          overview: { Name: "Test Industries" },
          income: {
            annualReports: [
              {
                fiscalDateEnding: "2025-12-31",
                reportedCurrency: "USD",
                totalRevenue: "100000000",
              },
            ],
          },
          balance: { annualReports: [] },
          cashflow: { annualReports: [] },
        },
      });
      tx.oncomplete = () => r();
    });
    db.close();
  });
  await search(page);
  expect(calls).toEqual(["prices"]);
  await expect(page.locator(".metric-highlight .metric-value")).toHaveText(
    "100.0M",
  );
});

test("concurrent tabs share first downloads", async ({ page, context }) => {
  const tab = await context.newPage();
  const calls: string[] = [];
  await stub(page, calls);
  await stub(tab, calls);
  await Promise.all([page.goto("./"), tab.goto("./")]);
  await Promise.all([search(page), search(tab)]);
  expect(calls.filter((c) => c === "financials")).toHaveLength(1);
  expect(calls.filter((c) => c === "prices")).toHaveLength(1);
});
