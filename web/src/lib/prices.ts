import { providerRequest } from "./service";
import { priceCacheGeneration, savedPrices, savePrices } from "./storage";
import type { PriceHistory } from "./types";

function validatePrices(history: PriceHistory, ticker: string): PriceHistory {
  if (
    !history ||
    history.ticker !== ticker ||
    history.outputSize !== "full" ||
    !Array.isArray(history.points) ||
    !history.points.length ||
    history.points.some(
      (p) =>
        !p ||
        typeof p.date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(p.date) ||
        !Number.isFinite(Date.parse(p.date)) ||
        new Date(p.date).toISOString().slice(0, 10) !== p.date ||
        !Number.isFinite(p.close) ||
        p.close <= 0,
    )
  )
    throw new Error(
      "The provider returned malformed daily prices. No price data was saved.",
    );
  return {
    ...history,
    points: [...history.points].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

interface LoadedPrices {
  history: PriceHistory;
  cached: boolean;
  warning: string;
}
const active = new Map<string, Promise<LoadedPrices>>();
// A download started before the panel that will show it exists. Statements and
// daily closes are separate Yahoo answers and neither needs the other, so the
// price request begins when a company is opened rather than when the chart
// mounts, which is only after the statements have arrived and been analyzed.
const warmed = new Map<string, Promise<LoadedPrices>>();

/**
 * Starts the daily closes for `ticker` alongside whatever else is loading. The
 * panel takes this exact result when it mounts — its cached flag and any
 * storage warning included — as if it had asked for it itself.
 */
export function warmPrices(ticker: string, apiKey: string): void {
  // A previous company load can fail before its panel mounts, leaving this
  // ticker's warm result unclaimed. Do not let a retry consume that stale
  // promise (especially a rejection from a transient outage).
  warmed.clear();
  const promise = loadPrices(ticker, apiKey);
  // Nothing is waiting on it yet, and a failure must not surface as an
  // unhandled rejection before the panel is there to show it.
  void promise.catch(() => {});
  // One company is on screen at a time, so an unclaimed older download is only
  // holding a price history in memory.
  warmed.set(ticker, promise);
}

export function loadPrices(
  ticker: string,
  apiKey: string,
  refresh = false,
): Promise<LoadedPrices> {
  // Refresh price asks for a new download by definition, so it never takes a
  // result that was already in hand.
  const warm = refresh ? undefined : warmed.get(ticker);
  if (warm) {
    warmed.delete(ticker);
    return warm;
  }
  const existing = active.get(ticker);
  if (existing) return existing;
  const load = async (generation: number): Promise<LoadedPrices> => {
    let saved: PriceHistory | undefined;
    if (!refresh) {
      saved = await savedPrices(ticker);
      if (saved?.outputSize === "full")
        return { history: saved, cached: true, warning: "" };
    }
    let history: PriceHistory;
    try {
      history = validatePrices(
        await providerRequest<PriceHistory>("prices", ticker, apiKey),
        ticker,
      );
    } catch (error) {
      if (!saved) throw error;
      return {
        history: saved,
        cached: true,
        warning: `Showing limited saved prices. ${error instanceof Error ? error.message : String(error)}`,
      };
    }
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
      ? await navigator.locks.request(`financials:prices:${ticker}`, () =>
          load(generation),
        )
      : await load(generation);
  })().finally(() => active.delete(ticker));
  active.set(ticker, promise);
  return promise;
}
