import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Building2,
  ChartNoAxesCombined,
  ChevronRight,
  CircleAlert,
  Sigma,
  FileSpreadsheet,
  Layers3,
  Search,
  TrendingUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FinancialChart, RevenueStreams } from "@/components/financial-chart";
import { StockPriceChart } from "@/components/stock-price-chart";
import { OptionsOutlookPanel } from "@/components/options-outlook";
import { BalanceComposition } from "@/components/balance-composition";
import { CapitalIntensity } from "@/components/capital-intensity";
import { Metric } from "@/components/metric-card";
import { analyze } from "@/lib/engine";
import { loadStock, loadTickers } from "@/lib/provider";
import { warmPrices } from "@/lib/prices";
import { loadKey } from "@/lib/storage";
import { DataSettings } from "@/components/data-settings";
import { downloadStatements, number, percent } from "@/lib/format";
import {
  DEFAULT_TIME_SPAN,
  TIME_SPANS,
  spanSummary,
  timeSpan,
  type TimeSpanId,
} from "@/lib/timespan";
import type { Report, Section, TickerEntry } from "@/lib/types";

const SUGGESTION_LIMIT = 8;

function matchingTickers(value: string, tickers: TickerEntry[]): TickerEntry[] {
  const query = value.trim();
  if (!query) {
    return [];
  }
  return tickers
    .filter((t) => t.ticker.startsWith(query))
    .sort((a, b) => a.ticker.localeCompare(b.ticker))
    .slice(0, SUGGESTION_LIMIT);
}

function Brand({ onClick }: { onClick: () => void }) {
  return (
    <button className="brand" onClick={onClick} aria-label="Financials home">
      <span className="brand-mark">
        <BarChart3 size={21} />
      </span>
      <span>
        financials<span className="text-primary">.</span>
      </span>
    </button>
  );
}
function TickerForm({
  value,
  onChange,
  onSubmit,
  onSelect,
  tickers,
  busy,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  onSelect: (ticker: string) => void;
  tickers: TickerEntry[];
  busy: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputId = compact ? "header-ticker" : "landing-ticker";
  const listId = `${inputId}-suggestions`;
  const matches = useMemo(
    () => matchingTickers(value, tickers),
    [value, tickers],
  );
  const visible = open && matches.length > 0;

  function select(ticker: string) {
    onChange(ticker);
    onSelect(ticker);
    setOpen(false);
    setActive(-1);
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!visible) {
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % matches.length);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? matches.length - 1 : i - 1));
      return;
    }

    if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      select(matches[active].ticker);
      return;
    }

    if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }
  return (
    <form
      onSubmit={onSubmit}
      className={compact ? "ticker-form compact" : "ticker-form"}
      aria-label="Find company financials"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        Ticker symbol
      </label>
      <Search size={20} className="search-icon" aria-hidden="true" />
      <Input
        id={inputId}
        value={value}
        onChange={(e) => {
          onChange(e.target.value.toUpperCase());
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={
          compact ? "Search ticker" : "Enter a ticker symbol, e.g. AAPL"
        }
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={20}
        required
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        aria-describedby="ticker-hint"
      />
      <Button type="submit" disabled={busy} size={compact ? "sm" : "lg"}>
        {busy ? (
          "Loading…"
        ) : compact ? (
          <ArrowRight size={17} />
        ) : (
          <>
            Explore financials <ArrowRight size={17} />
          </>
        )}
      </Button>
      {visible && (
        <ul className="ticker-suggestions" id={listId} role="listbox">
          {matches.map((match, i) => (
            <li
              key={match.ticker}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(match.ticker)}
            >
              <span className="suggestion-ticker">{match.ticker}</span>
              <span className="suggestion-name">{match.name}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
function Statement({ section, report }: { section: Section; report: Report }) {
  const [view, setView] = useState("values");
  return (
    <div className="statement-panel">
      <div className="statement-heading">
        <div>
          <h2>{section.name}</h2>
          <p>
            {view === "values"
              ? `Amounts in ${report.currency || "reporting currency"} millions, except per-share figures.`
              : view === "percent"
                ? "Each metric as a percentage of revenue. EPS is excluded."
                : "Change from the previous fiscal year, using its absolute value as the denominator."}
          </p>
        </div>
        <Tabs value={view} onValueChange={setView}>
          <TabsList aria-label="Statement display">
            <TabsTrigger value="values">Financials</TabsTrigger>
            <TabsTrigger value="percent">% of Revenue</TabsTrigger>
            <TabsTrigger value="yoy">% Change YoY</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-64">Metric</TableHead>
              {report.years.map((y) => (
                <TableHead key={y} className="text-right min-w-28">
                  FY {y}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {section.rows.map((row, index) => (
              <TableRow
                key={`${row.label}-${index}`}
                className={row.subtotal ? "subtotal" : ""}
              >
                <TableCell>{row.label}</TableCell>
                {(view === "values"
                  ? row.values
                  : view === "percent"
                    ? row.percentRevenue
                    : row.changeYoy
                ).map((v, i) => (
                  <TableCell
                    key={i}
                    className={`text-right font-mono tabular-nums ${v !== null && v < 0 ? "negative" : ""}`}
                  >
                    {view === "values"
                      ? number(
                          v === null ? null : row.perShare ? v : v / 1e6,
                          row.perShare ? 2 : 1,
                        )
                      : percent(v)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <p className="footnote mt-4">
        — indicates unavailable data. Fiscal period ends:{" "}
        {report.points
          .map((p) => p.end || `FY ${p.year} unavailable`)
          .join(" · ")}
      </p>
    </div>
  );
}
export default function App() {
  const [apiKey, setApiKey] = useState(loadKey);
  const [settings, setSettings] = useState(false);
  const [cached, setCached] = useState(false);
  const [storageWarning, setStorageWarning] = useState("");
  const [ticker, setTicker] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [payload, setPayload] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [spanId, setSpanId] = useState<TimeSpanId>(DEFAULT_TIME_SPAN);
  const [endYear, setEndYear] = useState("");
  const [tab, setTab] = useState("overview");
  const [tickers, setTickers] = useState<TickerEntry[]>([]);
  const request = useRef<AbortController | null>(null);
  const rebuilt = useRef(0);
  // The ending year the report on screen was built with, as opposed to what
  // is currently typed: choosing a span must not commit a half-typed year.
  const applied = useRef("");
  const inputRef = useRef<string>("");
  // One window for everything that looks backwards: the statements and the
  // daily closes each take the part of it they can use. The options horizon
  // looks forward and stays the Options tab's own.
  const span = timeSpan(spanId);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    loadTickers()
      .then(setTickers)
      .catch(() => {
        // No suggestions is a minor degradation; entering a ticker directly still works.
      });
  }, []);
  async function load(e: FormEvent) {
    e.preventDefault();
    await openStock(ticker);
  }
  async function openStock(value: string, refresh = false) {
    const symbol = value.trim().toUpperCase();
    if (!/^[A-Z0-9.^=\-]{1,20}$/.test(symbol) || !/[A-Z0-9]/.test(symbol)) {
      setError("Enter a valid ticker symbol, such as AAPL or BRK-B.");
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    inputRef.current = symbol;
    try {
      // The statements and the daily closes are separate Yahoo answers and
      // neither needs the other, so the price download starts here instead of
      // waiting for the chart below to mount once the statements have arrived.
      // A refresh leaves prices where they are: Refresh price is their own
      // control, and the chart on screen is not re-reading them.
      if (!refresh) warmPrices(symbol, apiKey);
      const loaded = await loadStock(
        symbol,
        apiKey,
        refresh,
        endYear ? Number(endYear) : undefined,
      );
      if (controller.signal.aborted) return;
      const data = loaded.payload;
      const next = await analyze(
        symbol,
        data,
        span.years,
        endYear ? Number(endYear) : undefined,
      );
      if (controller.signal.aborted) return;
      applied.current = endYear;
      setCached(loaded.cached);
      setStorageWarning(loaded.warning);
      setSettings(false);
      setPayload(data);
      setReport(next);
      setTicker(symbol);
      setTab("overview");
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  // Re-reads the statements already in hand against a different window. The
  // analysis is local, so no span change ever costs a request; spans can be
  // clicked through faster than the engine answers, so only the window still
  // chosen when a run finishes is the one shown.
  async function rebuild(years: number) {
    if (!report || !payload) return;
    const id = ++rebuilt.current;
    setBusy(true);
    setError("");
    try {
      const next = await analyze(
        report.ticker,
        payload,
        years,
        applied.current ? Number(applied.current) : undefined,
      );
      if (rebuilt.current === id) setReport(next);
    } catch (e) {
      if (rebuilt.current === id)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (rebuilt.current === id) setBusy(false);
    }
  }
  async function updatePeriod(e: FormEvent) {
    e.preventDefault();
    applied.current = endYear;
    await rebuild(span.years);
  }
  // The price chart and the options horizon follow the span as it is chosen;
  // the statements are only re-analyzed when the fiscal window itself moves.
  function chooseSpan(next: TimeSpanId) {
    const chosen = timeSpan(next);
    setSpanId(chosen.id);
    if (chosen.years !== span.years) void rebuild(chosen.years);
  }
  function home() {
    request.current?.abort();
    applied.current = "";
    setReport(null);
    setPayload(null);
    setTicker("");
    setBusy(false);
    setError("");
    setEndYear("");
  }
  const latest = report?.points.filter((p) => p.revenue !== null).at(-1);
  const currency = report?.currency || "Reporting currency";
  const yearsLabel = report
    ? `FY ${report.years[0]}–${report.years.at(-1)}`
    : "";
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <Brand onClick={home} />
          <div className="header-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSettings(!settings)}
            >
              Data settings
            </Button>
            {report ? (
              <TickerForm
                value={ticker}
                onChange={setTicker}
                onSubmit={load}
                onSelect={(symbol) => void openStock(symbol)}
                tickers={tickers}
                busy={busy}
                compact
              />
            ) : (
              <div className="header-label">
                Company fundamentals <span className="status-dot" />
              </div>
            )}
          </div>
        </div>
      </header>
      <main>
        {settings && (
          <DataSettings
            apiKey={apiKey}
            onKey={setApiKey}
            onClose={() => setSettings(false)}
            onOpenStock={(symbol) => {
              setSettings(false);
              void openStock(symbol);
            }}
            busy={busy}
          />
        )}
        {!report && !busy ? (
          <div className="landing">
            <div className="landing-main">
              <div className="eyebrow">
                <span className="eyebrow-line" />
                LOOK BEYOND THE STOCK PRICE
              </div>
              <h1>
                A clearer view of
                <br />
                the <span>business.</span>
              </h1>
              <p className="landing-description">
                From revenue to reinvestment. Explore the numbers
                <br className="desktop-break" /> behind a company, all in one
                place.
              </p>
              <TickerForm
                value={ticker}
                onChange={setTicker}
                onSubmit={load}
                onSelect={(symbol) => void openStock(symbol)}
                tickers={tickers}
                busy={busy}
              />
              <p id="ticker-hint" className="ticker-hint">
                Enter a ticker, or open a saved stock in Data settings.
              </p>
              {error && (
                <Alert variant="destructive" className="landing-alert">
                  <CircleAlert />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="ticker-examples">
                <span>Try a company</span>
                {["AAPL", "MSFT", "GOOGL", "AMZN"].map((symbol) => (
                  <button key={symbol} onClick={() => setTicker(symbol)}>
                    {symbol}
                    <ArrowUpRight size={13} />
                  </button>
                ))}
              </div>
              <div className="landing-features">
                <div>
                  <ChartNoAxesCombined />
                  <h2>See the whole picture</h2>
                  <p>
                    Revenue, earnings, and margins
                    <br />
                    over three or more fiscal years.
                  </p>
                </div>
                <div>
                  <Layers3 />
                  <h2>Follow the investment</h2>
                  <p>
                    Capital spending and cash flow.
                    <br />
                    See what powers future growth.
                  </p>
                </div>
                <div>
                  <FileSpreadsheet />
                  <h2>Get into the details</h2>
                  <p>
                    Three financial statements.
                    <br />
                    Every number, in context.
                  </p>
                </div>
              </div>
            </div>
            <div className="landing-bottom">
              <span>Annual financial statements</span>
              <span>Yahoo Finance · SEC EDGAR · Alpha Vantage</span>
            </div>
          </div>
        ) : null}
        {busy && !report ? (
          <div
            className="dashboard loading-state"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="eyebrow">COMPANY OVERVIEW</div>
            <h1>Loading {inputRef.current} financials…</h1>
            <p>Gathering annual statements and preparing your dashboard.</p>
            <div className="metric-grid mt-8">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-36 rounded-xl" />
              ))}
            </div>
            <div className="chart-grid mt-6">
              <Skeleton className="h-96 rounded-xl" />
              <Skeleton className="h-96 rounded-xl" />
            </div>
          </div>
        ) : null}
        {report && latest ? (
          <div className="dashboard" aria-busy={busy}>
            <div className="breadcrumb">
              <button onClick={home}>Companies</button>
              <ChevronRight size={13} />
              <span>{report.ticker}</span>
            </div>
            <div className="dashboard-heading">
              <div>
                <div className="flex items-center gap-3">
                  <h1>{report.name}</h1>
                  <Badge variant="outline">{report.ticker}</Badge>
                </div>
                <p>
                  Company financials <span>·</span> {yearsLabel} <span>·</span>{" "}
                  {currency}
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => openStock(report.ticker, true)}
                >
                  Refresh data
                </Button>
                <Button
                  variant="outline"
                  onClick={() => downloadStatements(report)}
                >
                  <ArrowDownToLine size={16} />
                  Export CSV
                </Button>
              </div>
            </div>
            <Alert role="status" className="cache-status">
              <AlertDescription>
                {cached
                  ? "Loaded from this browser’s saved statements. No API requests used for statements."
                  : "Loaded from financial data providers."}{" "}
                Saved data stays unchanged until you refresh it.
                {storageWarning && <p>{storageWarning}</p>}
              </AlertDescription>
            </Alert>
            <div className="dashboard-toolbar">
              <div className="toolbar-note">
                <span className="status-dot" />
                Annual reporting <span className="toolbar-divider" />
                Amounts in millions
              </div>
              <form onSubmit={updatePeriod} className="period-form">
                <span id="time-span-label">Time span</span>
                {/* type="multiple" is deliberate: Radix's type="single" swaps
                    in radiogroup/radio semantics and drops aria-pressed, which
                    the Playwright suite asserts on via getByRole("button", …).
                    A single-element value array keeps this a single-select. */}
                <ToggleGroup
                  type="multiple"
                  role="group"
                  value={[span.id]}
                  onValueChange={(values) => {
                    const next = values.find((v) => v !== span.id);

                    if (next) {
                      chooseSpan(next as TimeSpanId);
                    }
                  }}
                  className="span-ranges"
                  aria-labelledby="time-span-label"
                >
                  {TIME_SPANS.map((option) => (
                    <ToggleGroupItem
                      key={option.id}
                      value={option.id}
                      size="sm"
                      aria-label={option.label}
                    >
                      {option.short}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <label htmlFor="end-year">Ending</label>
                <Input
                  id="end-year"
                  type="number"
                  min={1900}
                  max={2200}
                  placeholder="Latest"
                  value={endYear}
                  onChange={(e) => setEndYear(e.target.value)}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                >
                  Apply
                </Button>
              </form>
            </div>
            <p className="span-summary footnote" role="status">
              {spanSummary(span)}
            </p>
            {error && (
              <Alert variant="destructive" className="dashboard-alert">
                <CircleAlert />
                <AlertDescription className="dashboard-alert-body">
                  <span>{error}</span>
                  <button
                    onClick={() => setError("")}
                    aria-label="Dismiss error"
                  >
                    <X size={16} />
                  </button>
                </AlertDescription>
              </Alert>
            )}
            {busy && (
              <p className="refreshing" role="status">
                Updating financials…
              </p>
            )}
            <StockPriceChart
              key={report.ticker}
              ticker={report.ticker}
              apiKey={apiKey}
              span={span}
              onSettings={() => setSettings(true)}
            />
            <div className="section-caption">
              <span>AT A GLANCE</span>
              <span>Fiscal year {latest.year}</span>
            </div>
            <div className="metric-groups">
              <div className="metric-group">
                <div className="metric-group-label">Profitability</div>
                <div
                  className="metric-grid"
                  style={{ "--metric-cols": 3 } as React.CSSProperties}
                >
                  <Metric
                    label="Total revenue"
                    value={latest.revenue}
                    unit="M"
                    detail={
                      latest.revenueGrowth === null
                        ? "Year-over-year change unavailable"
                        : `${percent(latest.revenueGrowth)} year over year`
                    }
                    points={report.points}
                    trendKey="revenue"
                    highlight
                  />
                  <Metric
                    label="Net income"
                    value={latest.netIncome}
                    unit="M"
                    detail={`${percent(latest.netMargin)} net margin`}
                    points={report.points}
                    trendKey="netIncome"
                  />
                  <Metric
                    label="Gross margin"
                    value={latest.grossMargin}
                    unit="%"
                    detail="Gross profit / revenue"
                    points={report.points}
                    trendKey="grossMargin"
                  />
                </div>
              </div>
              <div className="metric-group">
                <div className="metric-group-label">Cash generation</div>
                <div
                  className="metric-grid"
                  style={{ "--metric-cols": 3 } as React.CSSProperties}
                >
                  <Metric
                    label="Operating cash flow"
                    value={latest.operatingCashFlow}
                    unit="M"
                    detail="Cash generated by operations"
                    points={report.points}
                    trendKey="operatingCashFlow"
                  />
                  <Metric
                    label="Free cash flow"
                    value={latest.freeCashFlow}
                    unit="M"
                    detail="Cash after capital expenditure"
                    points={report.points}
                    trendKey="freeCashFlow"
                  />
                  <Metric
                    label="Capital expenditure"
                    value={latest.capex}
                    unit="M"
                    detail="Cash investment, shown as an outflow"
                    points={report.points}
                    trendKey="capex"
                  />
                </div>
              </div>
            </div>
            <Tabs value={tab} onValueChange={setTab} className="dashboard-tabs">
              <div className="tabs-heading">
                <TabsList
                  variant="line"
                  aria-label="Financial dashboard sections"
                >
                  <TabsTrigger value="overview">
                    <ChartNoAxesCombined size={15} />
                    Overview
                  </TabsTrigger>
                  <TabsTrigger value="capital">
                    <Building2 size={15} />
                    Capital & D&A
                  </TabsTrigger>
                  <TabsTrigger value="income">Income statement</TabsTrigger>
                  <TabsTrigger value="balance">Balance sheet</TabsTrigger>
                  <TabsTrigger value="cashflow">Cash flow</TabsTrigger>
                  <TabsTrigger value="options">
                    <Sigma size={15} />
                    Options
                  </TabsTrigger>
                </TabsList>
                <span>{yearsLabel}</span>
              </div>
              <TabsContent value="overview">
                <div className="chart-grid">
                  <FinancialChart
                    title="Revenue"
                    description="The company's top-line growth"
                    points={report.points}
                    series={[{ key: "revenue", label: "Revenue" }]}
                    unit={`${currency} M`}
                  />
                  <FinancialChart
                    title="Net income"
                    description="Profitability, on its own scale"
                    points={report.points}
                    series={[
                      {
                        key: "netIncome",
                        label: "Net income",
                        color: "var(--chart-2)",
                      },
                    ]}
                    unit={`${currency} M`}
                  />
                  <FinancialChart
                    title="Gross profit"
                    description="Revenue after the cost of goods and services"
                    points={report.points}
                    series={[{ key: "grossProfit", label: "Gross profit" }]}
                    unit={`${currency} M`}
                  />
                  <FinancialChart
                    title="Gross margin"
                    description="How much of each revenue unit remains"
                    points={report.points}
                    series={[
                      {
                        key: "grossMargin",
                        label: "Gross margin",
                        color: "var(--chart-2)",
                      },
                    ]}
                    type="line"
                    unit="% of revenue"
                    percent
                  />
                  <FinancialChart
                    title="Cash generation"
                    description="Cash from operations and after capital investment"
                    points={report.points}
                    series={[
                      {
                        key: "operatingCashFlow",
                        label: "Operating cash flow",
                      },
                      {
                        key: "freeCashFlow",
                        label: "Free cash flow",
                        color: "var(--chart-2)",
                      },
                    ]}
                    unit={`${currency} M`}
                  />
                  <RevenueStreams
                    points={report.points}
                    names={report.streamNames}
                    currency={currency}
                  />
                  <Card className="reading-card">
                    <div className="reading-icon">
                      <TrendingUp size={21} />
                    </div>
                    <h2>Read the numbers in context.</h2>
                    <p>
                      Revenue tells you about scale. Margins show profitability.
                      Cash flow and capital expenditure help explain how the
                      business is funding its next chapter.
                    </p>
                    <div className="reading-divider" />
                    <p className="text-sm">
                      One time span at the top of the dashboard sets this
                      window, for the statements charted here and the daily
                      closes above them alike. Missing values stay missing, and
                      negative values are preserved.
                    </p>
                    <div className="reading-links">
                      <Button
                        variant="ghost"
                        className="px-0"
                        onClick={() => setTab("capital")}
                      >
                        See capital investment & D&A <ArrowRight size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-0"
                        onClick={() => setTab("cashflow")}
                      >
                        Explore the cash flow statement <ArrowRight size={16} />
                      </Button>
                    </div>
                  </Card>
                </div>
              </TabsContent>
              <TabsContent value="capital">
                <CapitalIntensity report={report} />
              </TabsContent>
              <TabsContent value="income">
                <Statement section={report.statements[0]} report={report} />
              </TabsContent>
              <TabsContent value="balance">
                <BalanceComposition report={report} />
                <Statement section={report.statements[1]} report={report} />
              </TabsContent>
              <TabsContent value="cashflow">
                <Statement section={report.statements[2]} report={report} />
              </TabsContent>
              <TabsContent value="options">
                <OptionsOutlookPanel
                  key={report.ticker}
                  report={report}
                  apiKey={apiKey}
                />
              </TabsContent>
            </Tabs>
            <details className="data-notes">
              <summary>
                <CircleAlert size={15} />
                Data coverage & definitions{" "}
                {report.warnings.length > 0 && (
                  <Badge variant="secondary">
                    {report.warnings.length} notes
                  </Badge>
                )}
              </summary>
              <div>
                <p>
                  Annual fundamentals from the sources listed below. Fiscal
                  years ending January 1–7 are assigned to the preceding year.
                  Ratios with missing or nonpositive denominators are
                  unavailable. Cash CAPEX is shown as a positive outflow; D&A /
                  gross PP&E uses year-end assets.
                </p>
                {report.warnings.map((warning, i) => (
                  <p key={i}>{warning}</p>
                ))}
                <p>
                  Gross profit and free cash flow may be derived when the source
                  omits them. Gross PP&E and working capital are also derived
                  when their components are available. Unsupported statement
                  rows remain blank.
                </p>
              </div>
            </details>
            <footer className="dashboard-footer">
              <span>
                Annual financial data · Yahoo Finance / SEC EDGAR / Alpha
                Vantage
              </span>
              <span>
                {report.fetchedAt
                  ? `Retrieved ${new Date(report.fetchedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                  : ""}
              </span>
            </footer>
          </div>
        ) : null}
      </main>
    </div>
  );
}
