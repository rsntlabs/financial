import type { BrowserProviders } from "../wasm/financial_core";
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

export async function providerRequest<T>(
  endpoint: "financials" | "prices",
  ticker: string,
  apiKey: string,
  endYear?: number,
): Promise<T> {
  proxyBase();
  let providers: BrowserProviders;
  try {
    providers = await getProviders();
  } catch {
    throw new Error(
      "The provider engine could not load. Refresh the page and try again.",
    );
  }
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
