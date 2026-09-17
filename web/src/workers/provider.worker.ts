import init, { BrowserProviders } from "../wasm/financial_core";

type ProviderRequest = {
  id: number;
  endpoint: "financials" | "prices";
  ticker: string;
  apiKey: string;
  endYear?: number;
};

type ProviderResponse =
  { id: number; result: unknown } | { id: number; error: string };

const HISTORY_YEARS = 10;
const ready = init().then(() => new BrowserProviders());
const workerScope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ProviderRequest>) => void,
  ): void;
  postMessage(response: ProviderResponse): void;
};

workerScope.addEventListener("message", async (event) => {
  const request = event.data;
  let response: ProviderResponse;
  try {
    const providers = await ready;
    const json =
      request.endpoint === "financials"
        ? await providers.financials(
            request.ticker,
            request.apiKey,
            HISTORY_YEARS,
            request.endYear,
          )
        : await providers.prices(request.ticker, request.apiKey);
    response = { id: request.id, result: JSON.parse(json) as unknown };
  } catch (error) {
    response = { id: request.id, error: String(error) };
  }
  workerScope.postMessage(response);
});
