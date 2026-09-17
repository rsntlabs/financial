export async function providerRequest<T>(
  endpoint: "financials" | "prices",
  ticker: string,
  apiKey: string,
  endYear?: number,
): Promise<T> {
  const response = await fetch(`/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticker,
      apiKey,
      years: 10,
      ...(endYear === undefined ? {} : { endYear }),
    }),
  });
  const body = (await response.json().catch(() => undefined)) as
    T | { error?: unknown } | undefined;
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "The provider service could not complete the request.";
    throw new Error(message);
  }
  if (body === undefined)
    throw new Error("The provider service returned an invalid response.");
  return body as T;
}
