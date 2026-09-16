import { analyze } from "./engine";
import { savedStock, saveStock } from "./storage";
import { providerRequest } from "./service";
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
      throw new Error(
        "Financial data service returned an unsupported response.",
      );
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
