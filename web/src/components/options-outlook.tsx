import { useMemo, useState } from "react";
import {
  Activity,
  CircleAlert,
  FunctionSquare,
  Sigma,
  TrendingUp,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Alert, AlertDescription } from "./ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_MAX_PREMIUM,
  DEFAULT_MIN_DELTA,
  DEFAULT_RISK_FREE_RATE,
  loadOutlook,
} from "@/lib/options";
import { number, percent } from "@/lib/format";
import type {
  Moneyness,
  Nullable,
  OptionCandidate,
  OptionStrategy,
  OptionsOutlook,
  Report,
  Working,
} from "@/lib/types";

// Anything from the next few weeks to the LEAPS a couple of years out; the
// engine measures whichever expiration the chain actually lists nearest it.
const HORIZONS = [
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
  { days: 45, label: "45 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
  { days: 365, label: "1 year" },
  { days: 545, label: "18 months" },
  { days: 730, label: "2 years" },
];
// Which strikes the contract table shows. This is a view filter, not an
// analysis input: the engine prices and ranks the whole chain either way, so
// changing it re-filters what is already on screen without a new request.
const MONEYNESS = [
  { value: "itm", label: "In the money" },
  { value: "atm", label: "At the money" },
  { value: "otm", label: "Out of the money" },
  { value: "all", label: "All strikes" },
] as const;
type MoneynessFilter = Moneyness | "all";
const DEFAULT_MONEYNESS: MoneynessFilter = "itm";

/** A user-typed limit, or the default when it is empty or out of range. */
const limit = (value: string, fallback: number, low: number, high: number) => {
  const parsed = Number(value);
  return value.trim() !== "" &&
    Number.isFinite(parsed) &&
    parsed >= low &&
    parsed <= high
    ? parsed
    : fallback;
};
const money = (value: Nullable, digits = 2) => number(value, digits);
const signed = (value: number, digits = 2) =>
  `${value > 0 ? "+" : ""}${number(value, digits)}`;
const cash = (value: Nullable) =>
  value === null
    ? "Unlimited"
    : `${value < 0 ? "−" : ""}${number(Math.abs(value), 0)}`;
const contractName = (contract: string) => contract || "—";

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="option-stat">
      <span className="option-stat-label">{label}</span>
      <span className="option-stat-value">{value}</span>
      <span className="option-stat-detail">{detail}</span>
    </div>
  );
}

function Legs({
  strategy,
  currency,
}: {
  strategy: OptionStrategy;
  currency: string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Leg</TableHead>
          <TableHead className="text-right">Strike</TableHead>
          <TableHead className="text-right">Mid</TableHead>
          <TableHead className="text-right">Delta</TableHead>
          <TableHead className="text-right">Theta</TableHead>
          <TableHead className="text-right">Vega</TableHead>
          <TableHead className="text-right">Rho</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {strategy.legs.map((leg) => (
          <TableRow key={`${leg.action}-${leg.contract}`}>
            <TableCell>
              <span className={leg.action === "buy" ? "leg-buy" : "leg-sell"}>
                {leg.action === "buy" ? "Buy" : "Sell"}
              </span>{" "}
              {leg.contracts} × {leg.kind} {money(leg.strike)} ·{" "}
              {leg.expiration}
              <div className="footnote">
                {contractName(leg.contract)} · IV{" "}
                {percent(leg.impliedVolatility)}
              </div>
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {money(leg.strike)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {money(leg.mid)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {signed(leg.greeks.delta)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {signed(leg.greeks.theta)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {money(leg.greeks.vega)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {money(leg.greeks.rho)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableBody>
        <TableRow className="subtotal">
          <TableCell>
            Net position ({currency}, one contract = 100 shares)
          </TableCell>
          <TableCell className="text-right" colSpan={2}>
            {strategy.netDebit >= 0
              ? `${cash(strategy.netDebit)} debit`
              : `${cash(-strategy.netDebit)} credit`}
          </TableCell>
          <TableCell className="text-right font-mono tabular-nums">
            {signed(strategy.netDelta, 1)}
          </TableCell>
          <TableCell className="text-right font-mono tabular-nums">
            {signed(strategy.netTheta, 1)}
          </TableCell>
          <TableCell className="text-right font-mono tabular-nums">
            {signed(strategy.netVega, 1)}
          </TableCell>
          <TableCell className="text-right font-mono tabular-nums">
            {signed(strategy.netRho, 1)}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

function Candidates({ rows }: { rows: OptionCandidate[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Contract</TableHead>
            <TableHead className="text-right">Strike</TableHead>
            <TableHead className="text-right">Mid</TableHead>
            <TableHead className="text-right">Premium</TableHead>
            <TableHead className="text-right">Model</TableHead>
            <TableHead className="text-right">Edge</TableHead>
            <TableHead className="text-right">IV</TableHead>
            <TableHead className="text-right">Delta</TableHead>
            <TableHead className="text-right">Gamma</TableHead>
            <TableHead className="text-right">Theta</TableHead>
            <TableHead className="text-right">Vega</TableHead>
            <TableHead className="text-right">Rho</TableHead>
            <TableHead className="text-right">P(ITM)</TableHead>
            <TableHead className="text-right">Score</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={14} className="footnote">
                No contract on this expiration sits there. Choose another
                moneyness to see the rest of the chain.
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <TableRow
              key={row.contract}
              className={row.eligible ? undefined : "candidate-excluded"}
            >
              <TableCell>
                {row.kind === "call" ? "Call" : "Put"} · {row.expiration}
                <div className="footnote">
                  {contractName(row.contract)} · IV {row.impliedSource}
                  {row.eligible ? "" : " · below minimum delta"}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {money(row.strike)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {money(row.mid)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {cash(row.premium)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {money(row.modelValue)}
              </TableCell>
              <TableCell
                className={`text-right font-mono tabular-nums ${row.edge < 0 ? "negative" : ""}`}
              >
                {percent(row.edge)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {percent(row.impliedVolatility)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {signed(row.greeks.delta)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {number(row.greeks.gamma, 4)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {signed(row.greeks.theta)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {money(row.greeks.vega)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {money(row.greeks.rho)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {percent(row.probabilityItm)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {number(row.score * 100, 0)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function StrategyCard({
  strategy,
  currency,
  primary = false,
}: {
  strategy: OptionStrategy;
  currency: string;
  primary?: boolean;
}) {
  return (
    <Card className={primary ? "option-strategy primary" : "option-strategy"}>
      <div className="option-strategy-heading">
        <div>
          <h3>{strategy.name}</h3>
          <p>{strategy.summary}</p>
        </div>
        <Badge variant={primary ? "default" : "outline"}>
          {strategy.direction}
        </Badge>
      </div>
      {primary && <p className="option-rationale">{strategy.rationale}</p>}
      <div className="option-stats">
        <Stat
          label={strategy.netDebit >= 0 ? "Net debit" : "Net credit"}
          value={cash(Math.abs(strategy.netDebit))}
          detail={`${currency} per spread`}
        />
        <Stat
          label="Max profit"
          value={cash(strategy.maxProfit)}
          detail="At expiry, before costs"
        />
        <Stat
          label="Max loss"
          value={cash(strategy.maxLoss)}
          detail="At expiry, before costs"
        />
        <Stat
          label="Probability of profit"
          value={percent(strategy.probabilityOfProfit)}
          detail="Model lognormal, at expiry"
        />
        <Stat
          label="Expected profit"
          value={cash(strategy.expectedProfit)}
          detail={`${percent(strategy.expectedProfit / strategy.capitalAtRisk)} of capital at risk`}
        />
        <Stat
          label="Breakeven"
          value={
            strategy.breakevens.length
              ? strategy.breakevens.map((b) => money(b)).join(" / ")
              : "—"
          }
          detail="Underlying price at expiry"
        />
      </div>
      {primary && <Legs strategy={strategy} currency={currency} />}
    </Card>
  );
}

/**
 * The Black-Scholes working behind one contract: the inputs, the shared
 * intermediate terms, then each Greek's formula with this contract's numbers
 * substituted into it. The values are the ones the ranking used — they come
 * from the engine, not from re-deriving anything in the browser.
 */
function Calculation({
  working,
  contract,
  choices,
  onSelect,
}: {
  working: Working;
  contract: string;
  choices: { contract: string; label: string }[];
  onSelect: (contract: string) => void;
}) {
  const { inputs } = working;
  return (
    <Card className="option-calculation">
      <div className="option-strategy-heading">
        <div>
          <h3>
            <FunctionSquare size={18} aria-hidden="true" /> How the Greeks are
            calculated
          </h3>
          <p>
            Black-Scholes-Merton on the quoted mid, per share of the underlying.
          </p>
        </div>
        <div className="option-controls">
          <label htmlFor="option-calculation-contract" className="sr-only">
            Contract to show the calculation for
          </label>
          <select
            id="option-calculation-contract"
            value={contract}
            onChange={(e) => onSelect(e.target.value)}
          >
            {choices.map((choice) => (
              <option key={choice.contract} value={choice.contract}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <dl className="option-inputs">
        {[
          ["S — spot", money(inputs.spot)],
          ["K — strike", money(inputs.strike)],
          ["σ — volatility", percent(inputs.sigma)],
          [
            "T — time to expiry",
            `${number(inputs.years, 4)} yr (${number(inputs.days, 0)} days)`,
          ],
          ["r — risk-free rate", percent(inputs.rate)],
          ["q — dividend yield", percent(inputs.dividendYield)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-28">Term</TableHead>
            <TableHead>Formula</TableHead>
            <TableHead>With this contract&rsquo;s values</TableHead>
            <TableHead className="text-right min-w-24">Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {working.terms.map((term) => (
            <TableRow key={term.symbol}>
              <TableCell className="font-mono">{term.symbol}</TableCell>
              <TableCell className="option-formula">{term.formula}</TableCell>
              <TableCell className="option-formula">
                {term.substituted}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {number(term.value, 4)}
              </TableCell>
            </TableRow>
          ))}
          {working.greeks.map((greek) => (
            <TableRow key={greek.symbol} className="subtotal">
              <TableCell className="font-mono">{greek.symbol}</TableCell>
              <TableCell className="option-formula">{greek.formula}</TableCell>
              <TableCell className="option-formula">
                {greek.substituted}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {number(greek.value, 4)}
                <div className="footnote">{greek.unit}</div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="footnote">
        N is the standard normal cumulative distribution and φ its density.
        Multiply any Greek by 100 shares for one contract, and by the signed
        quantity of each leg for the net position above.
      </p>
    </Card>
  );
}

/**
 * The Greeks-driven outlook, with its own horizon. The dashboard's time span
 * says how far back the user is looking; this says how far forward, to an
 * expiration the chain has to actually list, and is chosen per analysis rather
 * than per view — so it stays here rather than following the toolbar.
 */
export function OptionsOutlookPanel({
  report,
  apiKey,
}: {
  report: Report;
  apiKey: string;
}) {
  const [outlook, setOutlook] = useState<OptionsOutlook | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [horizon, setHorizon] = useState(DEFAULT_HORIZON_DAYS);
  const [shown, setShown] = useState("");
  const [rate, setRate] = useState(String(DEFAULT_RISK_FREE_RATE * 100));
  const [premium, setPremium] = useState(String(DEFAULT_MAX_PREMIUM));
  const [delta, setDelta] = useState(String(DEFAULT_MIN_DELTA));
  const [moneyness, setMoneyness] =
    useState<MoneynessFilter>(DEFAULT_MONEYNESS);

  async function run() {
    setBusy(true);
    setError("");
    try {
      setOutlook(
        await loadOutlook(report, apiKey, {
          horizonDays: horizon,
          riskFreeRate: Number(rate) / 100,
          maxPremium: limit(premium, DEFAULT_MAX_PREMIUM, 1, 10_000_000),
          minDelta: limit(delta, DEFAULT_MIN_DELTA, 0, 0.95),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // The contracts the table shows: the ranking the engine produced, narrowed
  // to the strikes the moneyness filter asks for.
  const rows = useMemo(
    () =>
      (outlook?.candidates ?? []).filter(
        (row) => moneyness === "all" || row.moneyness === moneyness,
      ),
    [outlook, moneyness],
  );

  // Every contract whose derivation can be shown: the recommended legs first,
  // then the shown candidates, without repeating a contract that is both.
  const derivations = useMemo(() => {
    const entries = new Map<string, { label: string; working: Working }>();
    const add = (
      contract: string,
      kind: string,
      strike: number,
      working: Working | null,
      prefix: string,
    ) => {
      if (working && !entries.has(contract))
        entries.set(contract, {
          label: `${prefix}${kind} ${money(strike)} · ${contract}`,
          working,
        });
    };
    for (const leg of outlook?.recommendation.legs ?? [])
      add(
        leg.contract,
        leg.kind,
        leg.strike,
        leg.working,
        `${leg.action === "buy" ? "Long" : "Short"} `,
      );
    for (const row of rows)
      add(row.contract, row.kind, row.strike, row.working, "");
    return entries;
  }, [outlook, rows]);
  const selected = derivations.get(shown) ?? derivations.values().next().value;
  const currency = outlook?.currency || report.currency || "Quote currency";
  return (
    <section className="options-panel" aria-label="Options outlook">
      <div className="statement-heading">
        <div>
          <h2>Options outlook</h2>
          <p>
            Fundamentals and price history set the direction; Black-Scholes
            Greeks on the live chain pick the structure. Model output, not
            investment advice.
          </p>
        </div>
        <div className="option-controls">
          <label htmlFor="option-horizon" className="sr-only">
            Horizon in days
          </label>
          <select
            id="option-horizon"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
          >
            {HORIZONS.map((horizon) => (
              <option key={horizon.days} value={horizon.days}>
                {horizon.label}
              </option>
            ))}
          </select>
          <label htmlFor="option-rate">Risk-free %</label>
          <Input
            id="option-rate"
            type="number"
            min={0}
            max={25}
            step={0.25}
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
          <label htmlFor="option-premium">Max premium</label>
          <Input
            id="option-premium"
            type="number"
            min={1}
            max={10000000}
            step={100}
            value={premium}
            onChange={(e) => setPremium(e.target.value)}
          />
          <label htmlFor="option-delta">Min delta</label>
          <Input
            id="option-delta"
            type="number"
            min={0}
            max={0.95}
            step={0.05}
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
          />
          <Button size="sm" disabled={busy} onClick={() => void run()}>
            {busy
              ? "Analyzing…"
              : outlook
                ? "Re-run analysis"
                : "Analyze options"}
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive" className="dashboard-alert">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {busy && !outlook ? (
        <div role="status" aria-label="Analyzing the option chain">
          <Skeleton className="h-72 w-full rounded-xl" />
        </div>
      ) : null}
      {!outlook && !busy ? (
        <Card className="reading-card option-intro">
          <div className="reading-icon">
            <Sigma size={21} />
          </div>
          <h2>Bring the Greeks into the picture.</h2>
          <p>
            The chain is quoted live and is never saved to this browser, so it
            is downloaded only when you ask for it. The analysis re-solves every
            implied volatility it cannot trust, prices delta, gamma, theta, vega
            and rho for each contract, and ranks structures by expected profit,
            probability of profit and how tradeable the quotes are. Choose a
            horizon from two weeks to two years, cap what a structure may cost
            to open, and set how much delta the contract carrying the view has
            to have.
          </p>
        </Card>
      ) : null}
      {outlook && (
        <>
          <div className="option-summary">
            <Card className="option-signal">
              <div className="option-strategy-heading">
                <div>
                  <h3>
                    <TrendingUp size={18} aria-hidden="true" /> {outlook.ticker}{" "}
                    view
                  </h3>
                  <p>
                    <span className="capitalize">
                      {outlook.signal.direction}
                    </span>{" "}
                    · {percent(outlook.signal.conviction)} conviction ·{" "}
                    <span className="capitalize">
                      {outlook.volatility.regime}
                    </span>{" "}
                    volatility
                  </p>
                </div>
                <Badge variant="outline">{money(outlook.spot)}</Badge>
              </div>
              <div className="option-stats">
                <Stat
                  label="Expiration"
                  value={outlook.forecast.expiration}
                  detail={`${number(outlook.forecast.daysToExpiry, 0)} days from ${outlook.asOf}`}
                />
                <Stat
                  label="Model target"
                  value={money(outlook.forecast.target)}
                  detail={`${signed(outlook.forecast.drift * 100, 1)}% annual drift from the view`}
                />
                <Stat
                  label="Expected move"
                  value={`± ${money(outlook.forecast.expectedMove)}`}
                  detail={`${percent(outlook.forecast.expectedMovePercent)} · ${money(outlook.forecast.lower)} to ${money(outlook.forecast.upper)}`}
                />
                <Stat
                  label="Implied volatility"
                  value={percent(outlook.volatility.impliedAtm)}
                  detail={`At the money · forecast ${percent(outlook.volatility.forecast)}`}
                />
                <Stat
                  label="Realized volatility"
                  value={percent(outlook.volatility.realized30)}
                  detail={`30 sessions · 90 sessions ${percent(outlook.volatility.realized90)}`}
                />
                <Stat
                  label="Variance premium"
                  value={percent(outlook.volatility.variancePremium)}
                  detail="Implied less realized"
                />
              </div>
              <div className="option-drivers">
                {outlook.signal.drivers.map((driver) => (
                  <div key={driver.label} className="option-driver">
                    <span>{driver.label}</span>
                    <div
                      className="option-driver-bar"
                      role="img"
                      aria-label={`${driver.label}: ${driver.detail}, score ${driver.score.toFixed(2)}`}
                    >
                      <span
                        className={driver.score < 0 ? "negative" : "positive"}
                        style={{
                          width: `${Math.min(Math.abs(driver.score), 1) * 50}%`,
                          [driver.score < 0 ? "right" : "left"]: "50%",
                        }}
                      />
                    </div>
                    <span className="footnote">{driver.detail}</span>
                  </div>
                ))}
              </div>
            </Card>
            <StrategyCard
              strategy={outlook.recommendation}
              currency={currency}
              primary
            />
          </div>
          {outlook.alternatives.length > 0 && (
            <>
              <div className="section-caption">
                <span>ALTERNATIVES</span>
                <span>Same expiration, same view</span>
              </div>
              <div className="option-alternatives">
                {outlook.alternatives.map((strategy) => (
                  <StrategyCard
                    key={strategy.name}
                    strategy={strategy}
                    currency={currency}
                  />
                ))}
              </div>
            </>
          )}
          <div className="section-caption">
            <span>CONTRACTS</span>
            <div className="option-controls">
              <label htmlFor="option-moneyness">Moneyness</label>
              <select
                id="option-moneyness"
                value={moneyness}
                onChange={(e) =>
                  setMoneyness(e.target.value as MoneynessFilter)
                }
              >
                {MONEYNESS.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <span className="option-ranking-note">
                <Activity size={13} aria-hidden="true" />
                <span>
                  Ranked by edge, alignment and liquidity · at most{" "}
                  {cash(outlook.maxPremium)} premium, at least{" "}
                  {number(outlook.minDelta, 2)} delta
                </span>
              </span>
            </div>
          </div>
          <Candidates rows={rows} />
          {selected && (
            <Calculation
              working={selected.working}
              contract={
                derivations.has(shown)
                  ? shown
                  : (derivations.keys().next().value ?? "")
              }
              choices={[...derivations].map(([contract, entry]) => ({
                contract,
                label: entry.label,
              }))}
              onSelect={setShown}
            />
          )}
          <details className="data-notes">
            <summary>
              <CircleAlert size={15} />
              Model assumptions & limits{" "}
              <Badge variant="secondary">{outlook.warnings.length} notes</Badge>
            </summary>
            <div>
              <p>
                Greeks are Black-Scholes-Merton values computed here from the
                quoted mid price, not provider data: delta and gamma per share,
                vega per volatility point, theta per calendar day, all scaled by
                100 shares in the net position row. Probabilities assume a
                lognormal underlying with the stated drift and forecast
                volatility, hold only at expiry, and ignore commissions,
                assignment and early exercise.
              </p>
              {outlook.warnings.map((warning, i) => (
                <p key={i}>{warning}</p>
              ))}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
