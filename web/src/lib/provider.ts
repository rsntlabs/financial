import { analyze } from "./engine";
import { savedStock, saveStock, savedTickers, saveTickers } from "./storage";
import { fetchTickers, primeTickers, providerRequest } from "./service";
import type { TickerEntry } from "./types";
// Legacy cached Alpha payloads remain readable by the analysis engine.
export interface FinancialPayload {
  income?: Record<string, unknown>;
  balance?: Record<string, unknown>;
  cashflow?: Record<string, unknown>;
  overview?: Record<string, unknown>;
  schemaVersion?: number;
  metrics?: Record<string, Record<string, number>>;
  sources?: Record<string, Record<string, string>>;
  fetchedAt: string;
}
export interface LoadedStock {
  payload: FinancialPayload;
  cached: boolean;
  warning: string;
}
const active = new Map<string, Promise<LoadedStock>>();
export function loadStock(
  ticker: string,
  apiKey: string,
  refresh = false,
  endYear?: number,
): Promise<LoadedStock> {
  const id = `${ticker}:${endYear ?? "latest"}`;
  if (active.has(id)) return active.get(id)!;
  const load = async (): Promise<LoadedStock> => {
    if (!refresh) {
      const saved = await savedStock(ticker);
      if (saved) return { payload: saved.payload, cached: true, warning: "" };
    }
    const payload = await providerRequest<FinancialPayload>(
      "financials",
      ticker,
      apiKey,
      endYear,
    );
    if (payload.schemaVersion !== 1)
      throw new Error("Providers returned an unsupported response.");
    await analyze(ticker, payload, 5, endYear);
    let warning = "";
    try {
      await saveStock({ ticker, fetchedAt: payload.fetchedAt, payload });
    } catch {
      warning =
        "Statements loaded but could not be saved. Check browser storage settings.";
    }
    return { payload, cached: false, warning };
  };
  const promise = (async () =>
    navigator.locks
      ? await navigator.locks.request(`financials:${id}`, load)
      : await load())().finally(() => active.delete(id));
  active.set(id, promise);
  return promise;
}
let tickersRequest: Promise<TickerEntry[]> | null = null;
export function loadTickers(): Promise<TickerEntry[]> {
  tickersRequest ??= (async () => {
    const saved = await savedTickers();
    if (saved) {
      // Downloading this list is what fills the engine's ticker -> CIK map, so
      // a page answering the dropdown from storage has an empty one and would
      // download the SEC file again inside the first statement request. Seed
      // it here instead, while the user is still choosing a company, and load
      // the engine itself the same way ahead of the first search.
      void primeTickers(saved).catch(() => {
        // Only a head start: the engine downloads the file itself if it needs it.
      });
      return saved;
    }
    // A downloaded list leaves the engine's own map filled already.
    const list = await fetchTickers();
    try {
      await saveTickers(list);
    } catch {
      // A saved cache only speeds up the next page load; a fetched list still works this session.
    }
    return list;
  })().catch((e) => {
    tickersRequest = null;
    throw e;
  });
  return tickersRequest;
}
