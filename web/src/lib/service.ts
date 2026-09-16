import { acquire } from "./engine";

export async function providerRequest<T>(
  endpoint: "financials" | "prices",
  ticker: string,
  apiKey: string,
  endYear?: number,
): Promise<T> {
  return (await acquire(endpoint, ticker, apiKey, endYear)) as T;
}
