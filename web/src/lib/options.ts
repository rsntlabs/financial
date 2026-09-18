import { loadEngine } from "./wasm";
import { fetchOptionChain } from "./service";
import { loadPrices } from "./prices";
import type {
  OptionChain,
  OptionsOutlook,
  PriceHistory,
  Report,
} from "./types";

export const DEFAULT_HORIZON_DAYS = 45;
export const DEFAULT_RISK_FREE_RATE = 0.04;

export interface OptionsSettings {
  horizonDays: number;
  riskFreeRate: number;
}

export async function analyzeOptions(
  report: Report,
  prices: PriceHistory,
  chain: OptionChain,
  settings: OptionsSettings,
): Promise<OptionsOutlook> {
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
      engine.analyze_options(
        JSON.stringify({ report, prices, chain, settings }),
      ),
    ) as OptionsOutlook;
  } catch (error) {
    throw new Error(String(error));
  }
}

/**
 * The chain is quoted intraday and is never cached; the daily closes it is
 * measured against are the same ones the price chart already saved.
 */
export async function loadOutlook(
  report: Report,
  apiKey: string,
  settings: OptionsSettings,
): Promise<OptionsOutlook> {
  const [chain, prices] = await Promise.all([
    fetchOptionChain(report.ticker, settings.horizonDays),
    loadPrices(report.ticker, apiKey).then((loaded) => loaded.history),
  ]);
  return analyzeOptions(report, prices, chain, settings);
}
