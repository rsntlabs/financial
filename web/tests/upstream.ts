import { expect, type Page, type Route } from "@playwright/test";

export const UPSTREAM =
  /^https:\/\/(?:fc\.yahoo\.com|query[12]\.finance\.yahoo\.com|www\.sec\.gov|data\.sec\.gov|www\.alphavantage\.co)\//;
export const STATEMENTS =
  "https://query*.finance.yahoo.com/ws/fundamentals-timeseries/**";
export const CHART = "https://query*.finance.yahoo.com/v8/finance/chart/**";
export const KEY = "TESTKEY123";
export const HTTP = {
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  SERVICE_UNAVAILABLE: 503,
} as const;
export function fixture() {
  const values = {
    annualTotalRevenue: 100e6,
    annualNetIncome: 10e6,
    annualCostOfRevenue: 40e6,
    annualGrossProfit: 60e6,
    annualNetPPE: 150e6,
    annualGrossPPE: 200e6,
    annualTotalAssets: 300e6,
    annualTotalLiabilitiesNetMinorityInterest: 100e6,
    annualCapitalExpenditure: 20e6,
    annualDepreciationAmortizationDepletion: 10e6,
    annualOperatingCashFlow: 30e6,
  };
  return {
    schemaVersion: 1,
    name: "Test Industries",
    currency: "USD",
    fetchedAt: "2026-09-16T00:00:00Z",
    metrics: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        Object.fromEntries(
          [2021, 2022, 2023, 2024, 2025].map((y) => [
            `${y}-12-31`,
            key === "annualNetIncome" && y === 2023 ? -5e6 : value * (y - 2020),
          ]),
        ),
      ]),
    ),
    sources: {
      annualTotalRevenue: { "2025-12-31": "Yahoo Finance" },
      annualNetPPE: { "2025-12-31": "SEC EDGAR" },
    },
    warnings: ["Sources: Yahoo Finance, SEC EDGAR."],
  };
}
export function priceFixture(ticker = "TEST") {
  return {
    ticker,
    fetchedAt: "2026-09-16T00:00:00Z",
    source: "Yahoo Finance",
    outputSize: "full",
    points: [
      { date: "2026-05-15", close: 100 },
      { date: "2026-06-16", close: 105 },
      { date: "2026-08-14", close: 110 },
      { date: "2026-09-01", close: 115 },
      { date: "2026-09-14", close: 120 },
      { date: "2026-09-15", close: 126 },
    ],
  };
}

export function timeseries(data = fixture(), types?: string[]) {
  return {
    timeseries: {
      error: null,
      result: Object.entries(data.metrics)
        .filter(([key]) => !types || types.includes(key))
        .map(([key, values]) => ({
          meta: { type: [key] },
          timestamp: Object.keys(values).map(
            (date) => Date.parse(`${date}T00:00:00Z`) / 1000,
          ),
          [key]: Object.entries(values).map(([date, value]) => ({
            asOfDate: date,
            periodType: "12M",
            currencyCode: "USD",
            reportedValue: { raw: value },
          })),
        })),
    },
  };
}

export function chart(data = priceFixture()) {
  const values = data.points.map((point) => point.close);
  return {
    chart: {
      error: null,
      result: [
        {
          meta: {
            symbol: data.ticker,
            currency: "USD",
            instrumentType: "EQUITY",
            exchangeTimezoneName: "UTC",
            dataGranularity: "1d",
          },
          timestamp: data.points.map(
            (point) => Date.parse(`${point.date}T12:00:00Z`) / 1000,
          ),
          indicators: {
            quote: [
              {
                open: values,
                high: values,
                low: values,
                close: values,
                volume: values.map(() => 1000),
              },
            ],
          },
        },
      ],
    },
  };
}

export async function fulfillChart(route: Route, data = priceFixture()) {
  const url = new URL(route.request().url());
  expect(url.searchParams.get("interval")).toBe("1d");
  expect(Number(url.searchParams.get("period1"))).toBeLessThan(
    Date.parse("1980-12-12") / 1000,
  );
  expect(url.searchParams.has("range")).toBe(false);
  return route.fulfill({ json: chart(data) });
}

export async function stub(page: Page, calls: string[] = [], key = "") {
  // Every external request is intercepted. /api requests fail this test immediately.
  await page.route("**/api/*", () => {
    throw new Error("Provider requests must originate in browser WASM");
  });
  await page.route(UPSTREAM, async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe("GET");
    if (url.hostname === "www.alphavantage.co") {
      expect(key).not.toBe("");
      expect(url.searchParams.get("apikey")).toBe(key);
      return route.fulfill({
        json: { "Error Message": "No extra test coverage" },
      });
    }
    expect(url.href).not.toContain(KEY);
    if (url.hostname === "fc.yahoo.com") {
      return route.fulfill({
        body: "",
        headers: {
          "set-cookie":
            "A1=test; Domain=.yahoo.com; Path=/; Secure; SameSite=None; HttpOnly",
        },
      });
    }
    if (url.pathname.endsWith("/getcrumb")) {
      return route.fulfill({ body: "test-crumb" });
    }
    if (url.pathname.includes("/timeseries/")) {
      const types = url.searchParams.get("type")!.split(",");
      if (types[0] === "annualTotalRevenue") {
        calls.push("financials");
      }
      return route.fulfill({ json: timeseries(fixture(), types) });
    }
    if (url.pathname.includes("/quoteSummary/")) {
      return route.fulfill({
        json: {
          quoteSummary: {
            error: null,
            result: [
              {
                quoteType: {
                  quoteType: "EQUITY",
                  longName: "Test Industries",
                  exchange: "NMS",
                },
                assetProfile: {},
              },
            ],
          },
        },
      });
    }
    if (url.pathname.includes("/chart/")) {
      calls.push("prices");
      return fulfillChart(
        route,
        priceFixture(decodeURIComponent(url.pathname.split("/").at(-1)!)),
      );
    }
    return route.fulfill({ status: HTTP.NOT_FOUND, json: {} });
  });
}
