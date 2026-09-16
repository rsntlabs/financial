import { fetchStatement } from "./engine";
import { priceCacheGeneration, savedPrices, savePrices } from "./storage";
import type { PriceHistory, PricePoint } from "./types";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parsePrices(
  body: Record<string, unknown>,
  ticker: string,
): PricePoint[] {
  const metadata = body["Meta Data"];
  const series = body["Time Series (Daily)"];
  if (
    !record(metadata) ||
    metadata["2. Symbol"] !== ticker ||
    !record(series) ||
    !Object.keys(series).length
  )
    throw new Error(
      `Daily prices are unavailable for ${ticker}. Check the ticker and its coverage.`,
    );
  const points = Object.entries(series).map(([date, row]) => {
    const close = record(row) ? row["4. close"] : undefined;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      typeof close !== "string" ||
      !/^\d+(\.\d+)?$/.test(close) ||
      !Number.isFinite(Number(close)) ||
      Number(close) <= 0
    )
      throw new Error(
        "Alpha Vantage returned malformed daily prices. No price data was saved.",
      );
    return { date, close: Number(close) };
  });
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

interface LoadedPrices {
  history: PriceHistory;
  cached: boolean;
  warning: string;
}
const active = new Map<string, Promise<LoadedPrices>>();
export function loadPrices(
  ticker: string,
  apiKey: string,
  refresh = false,
): Promise<LoadedPrices> {
  const existing = active.get(ticker);
  if (existing) return existing;
  const load = async (generation: number): Promise<LoadedPrices> => {
    if (!refresh) {
      const saved = await savedPrices(ticker);
      if (saved) return { history: saved, cached: true, warning: "" };
    }
    if (!apiKey)
      throw new Error(
        "Add your Alpha Vantage API key in Data settings to load prices. Saved financials are still available.",
      );
    const body = await fetchStatement(apiKey, ticker, "TIME_SERIES_DAILY");
    const history = {
      ticker,
      fetchedAt: new Date().toISOString(),
      points: parsePrices(body, ticker),
    };
    let warning = "";
    try {
      if (!(await savePrices(history, generation)))
        warning =
          "Prices are shown for this view only because saved data was cleared during the download.";
    } catch {
      warning =
        "Prices loaded but could not be saved. Check browser storage settings.";
    }
    return { history, cached: false, warning };
  };
  const promise = (async () => {
    // Capture before waiting for another tab's download as well as before fetching.
    const generation = await priceCacheGeneration();
    return navigator.locks
      ? await navigator.locks.request(`alphavantage:prices:${ticker}`, () =>
          load(generation),
        )
      : await load(generation);
  })().finally(() => active.delete(ticker));
  active.set(ticker, promise);
  return promise;
}
