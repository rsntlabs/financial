import type { Report } from "./types";
let enginePromise: Promise<typeof import("../wasm/financial_core")> | undefined;
async function getEngine() {
  enginePromise ??= import("../wasm/financial_core")
    .then(async (engine) => {
      await engine.default();
      return engine;
    })
    .catch((error) => {
      enginePromise = undefined;
      throw error;
    });
  return enginePromise;
}
export async function analyze(
  ticker: string,
  payload: unknown,
  years: number,
  endYear?: number,
): Promise<Report> {
  let engine;
  try {
    engine = await getEngine();
  } catch {
    throw new Error(
      "The analysis engine could not load. Refresh the page and try again.",
    );
  }
  try {
    return JSON.parse(
      engine.analyze_financials(
        ticker,
        JSON.stringify(payload),
        years,
        endYear,
      ),
    ) as Report;
  } catch (error) {
    throw new Error(String(error));
  }
}
const HISTORY_YEARS = 10;
let providers: import("../wasm/financial_core").BrowserProviders | undefined;
export async function acquire(
  endpoint: "financials" | "prices",
  ticker: string,
  apiKey: string,
  endYear?: number,
): Promise<unknown> {
  const engine = await getEngine();
  providers ??= new engine.BrowserProviders();
  try {
    const result =
      endpoint === "financials"
        ? await providers.financials(ticker, apiKey, HISTORY_YEARS, endYear)
        : await providers.prices(ticker, apiKey);
    return JSON.parse(result);
  } catch (error) {
    throw new Error(String(error));
  }
}
