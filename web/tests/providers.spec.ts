import { expect, test, type Page } from "@playwright/test";
import {
  CHART,
  fixture,
  fulfillChart,
  HTTP,
  KEY,
  plumbing,
  routeStatements,
  STATEMENTS,
  timeseries,
} from "./upstream";

async function search(page: Page) {
  await page.goto("./");
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
}

test("static page routes financial and price requests through the Cloudflare Worker proxy", async ({
  page,
}) => {
  const requests: string[] = [];
  await plumbing(page);
  await routeStatements(page, (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: timeseries() });
  });
  await page.route(CHART, (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return fulfillChart(route);
  });
  await search(page);
  await expect(
    page.getByRole("heading", { name: "Test Industries", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".price-value")).toHaveText("126.00");
  // Both are asked for at once, so which one is recorded first is not this
  // test's business; that each went to the proxy exactly once is.
  expect(requests).toHaveLength(2);
  expect(requests).toEqual(
    expect.arrayContaining([
      expect.stringContaining("/yahoo/timeseries/TEST"),
      expect.stringContaining("/yahoo/chart/TEST"),
    ]),
  );
});

test("API keys are sent only to Alpha Vantage, never to the Yahoo or SEC proxy", async ({
  page,
}) => {
  await plumbing(page);
  // Omit annual net income so Alpha Vantage is queried to try filling the gap.
  const data = fixture();
  delete data.metrics.annualNetIncome;
  await routeStatements(page, (route) =>
    route.fulfill({ json: timeseries(data) }),
  );
  await page.route(CHART, (route) => fulfillChart(route));

  let alphaRequest: string | undefined;
  await page.route("https://www.alphavantage.co/**", (route) => {
    alphaRequest = route.request().url();
    return route.fulfill({ json: {} });
  });
  const proxyRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/yahoo/") || url.includes("/sec/")) {
      proxyRequests.push(url);
    }
  });

  await page.goto("./");
  await page.getByRole("button", { name: "Data settings" }).click();
  await page.getByLabel("Alpha Vantage API key", { exact: true }).fill(KEY);
  await page.getByRole("button", { name: "Save API key", exact: true }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(
    page.getByRole("heading", { name: "Test Industries", exact: true }),
  ).toBeVisible();

  expect(alphaRequest).toContain(KEY);
  expect(proxyRequests.length).toBeGreaterThan(0);
  expect(proxyRequests.some((url) => url.includes(KEY))).toBe(false);
});

test("provider failures are surfaced without exposing malformed upstream responses", async ({
  page,
}) => {
  await plumbing(page);
  // A status outside yfinance-rs's retry list (408/429/500/502/503/504) keeps
  // this test from waiting through the client's exponential backoff retries.
  await page.route(STATEMENTS, (route) =>
    route.fulfill({ status: HTTP.NOT_FOUND, body: "" }),
  );
  await page.route(CHART, (route) => fulfillChart(route));
  await search(page);
  await expect(page.getByRole("alert")).toContainText(
    "No annual revenue available",
  );
});

test("a request can recover after a transient provider failure", async ({
  page,
}) => {
  let attempts = 0;
  await plumbing(page);
  await routeStatements(page, (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({ status: HTTP.SERVICE_UNAVAILABLE, body: "" });
    }
    return route.fulfill({ json: timeseries() });
  });
  await page.route(CHART, (route) => fulfillChart(route));

  await search(page);
  await expect(page.getByRole("alert")).toContainText(
    "No annual revenue available",
  );
  await page.getByRole("button", { name: "Explore financials" }).click();

  await expect(
    page.getByRole("heading", { name: "Test Industries", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".price-value")).toHaveText("126.00");
  expect(attempts).toBe(2);
});
