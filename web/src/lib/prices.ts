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
export function loadPrices(
  ticker: string,
  apiKey: string,
  refresh = false,
): Promise<LoadedPrices> {
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
