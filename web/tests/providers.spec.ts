import { expect, test } from "@playwright/test";
import { fixture, KEY, priceFixture } from "./upstream";

async function search(page: import("@playwright/test").Page) {
  await page.goto("./");
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
}

test("static page posts financial and price requests to the backend API", async ({
  page,
}) => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/*", (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push({ path: url.pathname, body });
    return route.fulfill({
      json:
        url.pathname === "/api/financials"
          ? fixture()
          : priceFixture(body.ticker as string),
    });
  });
  await search(page);
  await expect(
    page.getByRole("heading", { name: "Test Industries", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".price-value")).toHaveText("126.00");
  expect(requests.map(({ path }) => path)).toEqual([
    "/api/financials",
    "/api/prices",
  ]);
  expect(requests[0].body).toEqual({
    ticker: "TEST",
    apiKey: "",
    years: 10,
  });
});

test("API keys are sent only in backend request bodies", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/*", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    return route.fulfill({
      json: route.request().url().endsWith("/financials")
        ? fixture()
        : priceFixture(),
    });
  });
  await page.goto("./");
  await page.getByRole("button", { name: "Data settings" }).click();
  await page.getByLabel("Alpha Vantage API key", { exact: true }).fill(KEY);
  await page.getByRole("button", { name: "Save API key", exact: true }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByLabel("Ticker symbol", { exact: true }).fill("TEST");
  await page.getByRole("button", { name: "Explore financials" }).click();
  await expect(page.locator(".price-value")).toHaveText("126.00");
  expect(bodies).toHaveLength(2);
  expect(bodies.every(({ apiKey }) => apiKey === KEY)).toBe(true);
  expect(JSON.stringify(bodies)).toContain(KEY);
});

test("backend errors are surfaced without exposing malformed responses", async ({
  page,
}) => {
  await page.route("**/api/financials", (route) =>
    route.fulfill({ status: 502, json: { error: "Providers unavailable." } }),
  );
  await search(page);
  await expect(page.getByRole("alert")).toContainText("Providers unavailable.");
});
