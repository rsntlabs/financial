import type { Report } from "./types";
import { loadEngine } from "./wasm";
export async function analyze(
  ticker: string,
  payload: unknown,
  years: number,
  endYear?: number,
): Promise<Report> {
  let engine;
  try {
    engine = await loadEngine();
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
