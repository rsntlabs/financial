import { expect, type Page, type Route } from "@playwright/test";

export const UPSTREAM =
  /^https:\/\/(?:fc\.yahoo\.com|query[12]\.finance\.yahoo\.com|www\.sec\.gov|data\.sec\.gov|www\.alphavantage\.co)\//;
export const STATEMENTS = "**/api/financials";
export const CHART = "**/api/prices";
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
  return route.fulfill({ json: data });
}

export async function stub(page: Page, calls: string[] = [], key = "") {
  await page.route("**/api/*", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["content-type"]).toContain(
      "application/json",
    );
    const body = route.request().postDataJSON() as {
      ticker: string;
      apiKey: string;
      years: number;
      endYear?: number;
    };
    expect(body.years).toBe(10);
    expect(body.apiKey).toBe(key);
    if (route.request().url().endsWith("/api/financials")) {
      calls.push("financials");
      return route.fulfill({ json: fixture() });
    }
    calls.push("prices");
    return route.fulfill({ json: priceFixture(body.ticker) });
  });
  // Provider traffic belongs to the backend, never to the static page.
  await page.route(UPSTREAM, async (route) => {
    throw new Error(`Static page contacted upstream: ${route.request().url()}`);
  });
}
