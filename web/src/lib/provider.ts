import { analyze, fetchStatement } from "./engine";
import { pendingStock, savedStock, savePending, saveStock } from "./storage";
export interface AlphaPayload {
  income?: Record<string, unknown>;
  balance?: Record<string, unknown>;
  cashflow?: Record<string, unknown>;
  overview?: Record<string, unknown>;
  fetchedAt: string;
}
export interface LoadedStock {
  payload: AlphaPayload;
  cached: boolean;
  warning: string;
}
const endpoints = [
  ["income", "INCOME_STATEMENT"],
  ["balance", "BALANCE_SHEET"],
  ["cashflow", "CASH_FLOW"],
  ["overview", "OVERVIEW"],
] as const;
function validate(
  body: Record<string, unknown>,
  ticker: string,
  section: string,
) {
  if (section === "overview") {
    if (typeof body.Name !== "string" || !body.Name)
      throw new Error("Company name unavailable.");
    return;
  }
  if (
    body.symbol !== ticker ||
    !Array.isArray(body.annualReports) ||
    !body.annualReports.length
  ) {
    throw new Error(
      `Alpha Vantage has no annual ${section} statements for ${ticker}. Check the ticker and its coverage.`,
    );
  }
  if (
    !body.annualReports.some(
      (r) =>
        r &&
        /^\d{4}-\d{2}-\d{2}$/.test(r.fiscalDateEnding) &&
        (section !== "income" ||
          (typeof r.totalRevenue === "string" &&
            r.totalRevenue.trim() !== "" &&
            Number.isFinite(Number(r.totalRevenue)))),
    )
  ) {
    throw new Error(
      "Alpha Vantage returned malformed annual statements. No data was saved.",
    );
  }
}
// Share concurrent work within a tab. Web Locks serializes the same stock across tabs.
const active = new Map<string, Promise<LoadedStock>>();
export function loadStock(
  ticker: string,
  apiKey: string,
  refresh = false,
): Promise<LoadedStock> {
  if (active.has(ticker)) return active.get(ticker)!;
  const load = async (): Promise<LoadedStock> => {
    if (!refresh) {
      const saved = await savedStock(ticker);
      if (saved) return { payload: saved.payload, cached: true, warning: "" };
    }
    if (!apiKey)
      throw new Error(
        "Set up your Alpha Vantage API key in Data settings to fetch this stock. Saved stocks need no key.",
      );
    const partial = !refresh ? await pendingStock(ticker) : undefined;
    const payload: AlphaPayload = partial?.payload ?? {
      fetchedAt: new Date().toISOString(),
    };
    let warning = "";
    for (const [section, endpoint] of endpoints) {
      if (payload[section]) continue;
      // Sequential calls avoid bursts; transient retries are handled by the Rust client.
      try {
        const body = await fetchStatement(apiKey, ticker, endpoint);
        validate(body, ticker, section);
        payload[section] = body;
      } catch (error) {
        if (section !== "overview") throw error;
        warning =
          "Statements loaded; the company profile was unavailable. The ticker is shown instead.";
        break;
      }
      try {
        await savePending({ ticker, fetchedAt: payload.fetchedAt, payload });
      } catch {
        warning =
          "Browser storage could not save this download. It may need fetching again after you leave this page.";
      }
      if (section !== "overview")
        await new Promise((resolve) => setTimeout(resolve, 600));
    }
    // Validate the entire set with the same Rust engine used by the charts before publishing it.
    await analyze(ticker, payload, 5);
    try {
      await saveStock({ ticker, fetchedAt: payload.fetchedAt, payload });
    } catch {
      warning =
        "Statements loaded but could not be saved to disk. Subsequent visits may need API calls. Check browser storage settings.";
    }
    return { payload, cached: false, warning };
  };
  const promise: Promise<LoadedStock> = (async () =>
    navigator.locks
      ? await navigator.locks.request(`alphavantage:${ticker}`, load)
      : await load())().finally(() => active.delete(ticker));
  active.set(ticker, promise);
  return promise;
}
