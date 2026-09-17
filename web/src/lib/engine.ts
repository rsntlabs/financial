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
