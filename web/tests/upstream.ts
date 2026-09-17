import { type Page, type Route } from "@playwright/test";

// Yahoo and SEC must never be reached directly by the static page; every
// request goes through the Cloudflare Worker proxy instead. Alpha Vantage is
// not proxied (see docs/providers.md), so it is deliberately absent here.
export const UPSTREAM =
  /^https:\/\/(?:fc\.yahoo\.com|query[12]\.finance\.yahoo\.com|www\.sec\.gov|data\.sec\.gov)\//;
export const STATEMENTS = "**/yahoo/timeseries/**";
export const CHART = "**/yahoo/chart/**";
export const KEY = "TESTKEY123";
export const HTTP = {
  NOT_FOUND: 404,
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
  };
}
export function priceFixture(ticker = "TEST") {
  return {
    ticker,
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

// Yahoo's fundamentals-timeseries wire shape, as parsed by yahoo.rs's
// normalize_timeseries. This is the proxy route the WASM client uses to fill
// every dashboard metric in one request.
export function timeseries(data = fixture()) {
  return {
    timeseries: {
      error: null,
      result: Object.entries(data.metrics).map(([key, values]) => ({
        meta: { type: [key] },
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

// Yahoo's v8 chart wire shape, as parsed by yfinance-rs's history builder.
function chart(data = priceFixture()) {
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
  return route.fulfill({ json: chart(data) });
}

// SEC's company_tickers.json wire shape, as parsed by edgar_rs::Ticker.
function tickerFile(ticker = "TEST", cik = 1234, title = "Test Industries") {
  return { "0": { cik_str: cik, ticker, title } };
}

// A minimal companyfacts response: enough for edgar.rs to resolve the company
// name without contributing any financial value (no us-gaap facts at all).
function companyFacts(entityName = "Test Industries", cik = 1234) {
  return { cik, entityName, facts: {} };
}

// Yahoo profile/typed-statement lookups and SEC lookups are proxy plumbing,
// not test data: every test needs them stubbed, few tests care about their
// shape. The Yahoo session handshake needs no stub at all: the wasm32 client
// never fetches real credentials (see vendor/yfinance-rs's auth.rs patch).
export async function plumbing(page: Page) {
  await Promise.all([
    // yfinance-rs's typed statement and profile calls are not exercised here;
    // the timeseries route below supplies every dashboard metric instead.
    page.route("**/yahoo/quoteSummary/**", (route) =>
      route.fulfill({ status: HTTP.NOT_FOUND, body: "" }),
    ),
    page.route("**/sec/files/company_tickers.json", (route) =>
      route.fulfill({ json: tickerFile() }),
    ),
    page.route("**/sec/api/xbrl/companyfacts/**", (route) =>
      route.fulfill({ json: companyFacts() }),
    ),
    // fixture() only covers a subset of dashboard metrics, so Needs::remaining
    // never empties out and any test that supplies a key reaches Alpha Vantage
    // for the rest. A default empty-but-valid response keeps that deterministic
    // and fast; tests that care about the request itself register their own
    // more specific route, which Playwright resolves ahead of this one.
    page.route("https://www.alphavantage.co/**", (route) => route.fulfill({ json: {} })),
    // Provider traffic belongs to the proxy, never to the static page.
    page.route(UPSTREAM, async (route) => {
      throw new Error(`Static page contacted upstream directly: ${route.request().url()}`);
    }),
  ]);
}

// yfinance-rs's own typed statement calls (income/balance/cashflow, and a
// separate share-count lookup) also go through the timeseries route, each
// bounded to a multi-year lookback window. The dashboard's own supplemental
// request (yahoo.rs's extended_statement) always asks for the full history
// with period1=0, so that parameter — not the width of the "type" list —
// tells the two apart exactly. Only the full-history one carries test data;
// the bounded ones get an empty, well-formed response.
function isFullHistoryRequest(url: string): boolean {
  return new URL(url).searchParams.get("period1") === "0";
}
export async function routeStatements(
  page: Page,
  handler: (route: Route) => unknown,
) {
  await page.route(STATEMENTS, (route) => {
    if (!isFullHistoryRequest(route.request().url())) {
      return route.fulfill({ json: timeseries({ metrics: {} }) });
    }
    return handler(route);
  });
}

export async function stub(page: Page, calls: string[] = []) {
  await Promise.all([
    plumbing(page),
    routeStatements(page, (route) => {
      calls.push("financials");
      return route.fulfill({ json: timeseries() });
    }),
    page.route(CHART, (route) => {
      calls.push("prices");
      return fulfillChart(route);
    }),
  ]);
}
