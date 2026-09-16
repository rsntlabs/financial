// Only the configured service receives the optional key, in a POST body.
// A service outage never triggers direct paid-provider calls from the browser.
export const providerUrl = (
  import.meta.env.VITE_PROVIDER_URL || "/api"
).replace(/\/$/, "");
export async function providerRequest<T>(
  endpoint: "financials" | "prices",
  ticker: string,
  apiKey: string,
  endYear?: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${providerUrl}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker,
        apiKey,
        years: 10,
        ...(endYear === undefined ? {} : { endYear }),
      }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: AbortSignal.timeout(245000),
    });
  } catch {
    throw new Error(
      "Could not reach the financial data service. Check your connection and service configuration. Saved stocks still work.",
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body)
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : "Financial data service unavailable. Configure the provider service to use Yahoo Finance and SEC EDGAR.",
    );
  return body as T;
}
