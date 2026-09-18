import type { BrowserProviders } from "../wasm/financial_core";
import type { OptionChain, TickerEntry } from "./types";
import { loadEngine, loadOnce } from "./wasm";

const YEARS_REQUESTED = 10;

function proxyBase(): string {
  const base = import.meta.env.VITE_PROVIDER_PROXY_URL;
  if (!base) {
    throw new Error(
      "The provider proxy is not configured. Set VITE_PROVIDER_PROXY_URL to the deployed Cloudflare Worker origin.",
    );
  }
  return base;
}

const getProviders = loadOnce<BrowserProviders>(async () => {
  const engine = await loadEngine();
  return new engine.BrowserProviders(proxyBase());
});

// proxyBase() reports its own misconfiguration error before the engine is loaded.
async function loadProviders(): Promise<BrowserProviders> {
  proxyBase();
  try {
    return await getProviders();
  } catch {
    throw new Error(
      "The provider engine could not load. Refresh the page and try again.",
    );
  }
}

export async function providerRequest<T>(
  endpoint: "financials" | "prices",
  ticker: string,
  apiKey: string,
  endYear?: number,
): Promise<T> {
  const providers = await loadProviders();
  try {
    const json =
      endpoint === "financials"
        ? await providers.financials(ticker, apiKey, YEARS_REQUESTED, endYear)
        : await providers.prices(ticker, apiKey);
    return JSON.parse(json) as T;
  } catch (error) {
    // Rust rejects these promises with a plain string, not an Error object.
    throw new Error(String(error));
  }
}

/**
 * The option chain for the expiration nearest `horizonDays`. Yahoo is the only
 * provider that quotes contracts, so this takes no API key and has no fallback.
 */
export async function fetchOptionChain(
  ticker: string,
  horizonDays: number,
): Promise<OptionChain> {
  const providers = await loadProviders();
  try {
    return JSON.parse(
      await providers.options(ticker, Math.round(horizonDays)),
    ) as OptionChain;
  } catch (error) {
    throw new Error(String(error));
  }
}

export async function fetchTickers(): Promise<TickerEntry[]> {
  const providers = await loadProviders();
  try {
    return JSON.parse(await providers.tickers()) as TickerEntry[];
  } catch (error) {
    throw new Error(String(error));
  }
}
