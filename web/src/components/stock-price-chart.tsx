import { useCallback, useEffect, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./ui/chart";
import { Skeleton } from "./ui/skeleton";
import { loadPrices } from "@/lib/prices";
import type { PriceHistory } from "@/lib/types";

const price = (value: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
const signed = (value: number) => `${value > 0 ? "+" : ""}${price(value)}`;
const dateLabel = (value: string) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const config = { close: { label: "Daily close", color: "var(--chart-2)" } };

export function StockPriceChart({
  ticker,
  apiKey,
  onSettings,
}: {
  ticker: string;
  apiKey: string;
  onSettings: () => void;
}) {
  const [history, setHistory] = useState<PriceHistory | null>(null);
  const [cached, setCached] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [range, setRange] = useState("1M");
  const request = useRef(0);
  const load = useCallback(
    async (refresh = false) => {
      const id = ++request.current;
      setBusy(true);
      setError("");
      try {
        const result = await loadPrices(ticker, apiKey, refresh);
        if (request.current !== id) return;
        setHistory(result.history);
        setCached(result.cached);
        setWarning(result.warning);
      } catch (e) {
        if (request.current === id)
          setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (request.current === id) setBusy(false);
      }
    },
    [ticker, apiKey],
  );
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);

  const latest = history?.points.at(-1);
  const previous = history?.points.at(-2);
  const change = latest && previous ? latest.close - previous.close : null;
  // Anchor ranges to the latest available session, including for older cached data.
  const cutoff = latest ? new Date(`${latest.date}T00:00:00Z`) : null;
  if (cutoff && range !== "ALL") {
    const day = cutoff.getUTCDate();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - (range === "1M" ? 1 : 3));
    const lastDay = new Date(
      Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
    ).getUTCDate();
    cutoff.setUTCDate(Math.min(day, lastDay));
  }
  const points =
    history?.points.filter(
      (p) => range === "ALL" || p.date >= cutoff!.toISOString().slice(0, 10),
    ) ?? [];

  return (
    <section aria-label={`${ticker} stock price`} className="stock-price-panel">
      <Card className="chart-card">
        <CardHeader>
          <div className="price-heading">
            <div>
              <CardTitle>
                <h2>
                  Stock price{" "}
                  <span className="text-muted-foreground">· {ticker}</span>
                </h2>
              </CardTitle>
              <p className="footnote mt-1.5">
                Daily close · Exchange quote units
              </p>
            </div>
            <div className="price-actions">
              <div
                className="price-ranges"
                role="group"
                aria-label="Price history range"
              >
                {["1M", "3M", "ALL"].map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={range === value ? "secondary" : "ghost"}
                    aria-pressed={range === value}
                    disabled={!history}
                    onClick={() => setRange(value)}
                  >
                    {value === "ALL" ? "All" : value}
                  </Button>
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => (apiKey ? void load(true) : onSettings())}
              >
                <RefreshCw size={13} aria-hidden="true" />
                {busy ? "Loading prices…" : "Refresh price"}
              </Button>
            </div>
          </div>
          {latest && (
            <div className="price-summary">
              <span className="price-value">{price(latest.close)}</span>
              <span
                className={
                  change !== null && change < 0 ? "negative" : "price-change"
                }
              >
                {change !== null && previous
                  ? `${signed(change)} (${change > 0 ? "+" : ""}${((change / previous.close) * 100).toFixed(2)}%) vs previous close`
                  : "Previous close unavailable"}
              </span>
              <p className="footnote">
                As of {dateLabel(latest.date)} ·{" "}
                {cached ? "Saved prices" : "Downloaded prices"} · Not real-time
              </p>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {error && (
            <p role="alert" className="price-notice">
              {history && "Showing previous prices. "}
              {error}
            </p>
          )}
          {warning && (
            <p role="status" className="price-notice">
              {warning}
            </p>
          )}
          {busy && !history ? (
            <div role="status" aria-label="Loading stock prices">
              <Skeleton className="h-[240px] w-full rounded-lg" />
            </div>
          ) : latest ? (
            <>
              <ChartContainer
                config={config}
                className="h-[240px] w-full aspect-auto"
                role="img"
                aria-label={`${ticker} daily closing price, ${points[0].date} to ${latest.date}, ${points.length} trading sessions`}
              >
                <LineChart
                  accessibilityLayer
                  data={points}
                  margin={{ top: 12, right: 12, left: 0, bottom: 8 }}
                >
                  <CartesianGrid
                    vertical={false}
                    strokeDasharray="3 5"
                    stroke="var(--border)"
                  />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={45}
                    tickMargin={12}
                    tickFormatter={(value) =>
                      dateLabel(value).replace(/, \d{4}$/, "")
                    }
                  />
                  <YAxis
                    domain={["auto", "auto"]}
                    tickLine={false}
                    axisLine={false}
                    width={72}
                    tickFormatter={(value) =>
                      new Intl.NumberFormat("en-US", {
                        notation: "compact",
                        maximumFractionDigits: 2,
                      }).format(value)
                    }
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(value) => dateLabel(String(value))}
                        formatter={(value) => (
                          <div className="flex min-w-36 justify-between gap-5">
                            <span>Close</span>
                            <span className="font-mono">
                              {price(Number(value))}
                            </span>
                          </div>
                        )}
                      />
                    }
                  />
                  <Line
                    dataKey="close"
                    type="linear"
                    stroke="var(--color-close)"
                    strokeWidth={2}
                    dot={points.length === 1 ? { r: 4 } : false}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ChartContainer>
              <div className="price-footer footnote">
                <span>
                  {dateLabel(points[0].date)} – {dateLabel(latest.date)} ·{" "}
                  {points.length} trading sessions
                </span>
                <span>
                  Alpha Vantage · Up to 100 sessions · Unadjusted for splits and
                  dividends
                </span>
              </div>
            </>
          ) : !busy ? (
            <div className="chart-empty price-empty">
              <span>Price history unavailable</span>
              <p>Financial statements remain available below.</p>
              {!apiKey && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={onSettings}
                >
                  Set up price data
                </Button>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
