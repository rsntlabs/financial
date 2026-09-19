export type Nullable = number | null;
export interface TickerEntry {
  ticker: string;
  name: string;
}
export interface PricePoint {
  date: string;
  close: number;
}
export interface PriceHistory {
  ticker: string;
  fetchedAt: string;
  points: PricePoint[];
  outputSize?: "full";
  source?: string;
}
export interface Point {
  year: number;
  end: string | null;
  revenue: Nullable;
  netIncome: Nullable;
  grossProfit: Nullable;
  grossMargin: Nullable;
  operatingCashFlow: Nullable;
  freeCashFlow: Nullable;
  capex: Nullable;
  da: Nullable;
  daRevenue: Nullable;
  daPpe: Nullable;
  capexDa: Nullable;
  revenueGrowth: Nullable;
  netMargin: Nullable;
  streams: Record<string, number>;
}
export interface StatementRow {
  label: string;
  subtotal: boolean;
  perShare: boolean;
  values: Nullable[];
  percentRevenue: Nullable[];
  changeYoy: Nullable[];
}
export interface Section {
  name: string;
  rows: StatementRow[];
}
export interface Report {
  ticker: string;
  name: string;
  currency: string | null;
  years: number[];
  points: Point[];
  statements: Section[];
  warnings: string[];
  fetchedAt: string;
  streamNames: string[];
}
export type PointKey = Exclude<keyof Point, "year" | "end" | "streams">;
export type OptionKind = "call" | "put";
export type Direction = "bullish" | "neutral" | "bearish";
export type VolRegime = "rich" | "fair" | "cheap";
export interface Greeks {
  value: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}
export interface WorkingTerm {
  symbol: string;
  formula: string;
  substituted: string;
  value: number;
  unit: string;
}
export interface WorkingInputs {
  spot: number;
  strike: number;
  rate: number;
  dividendYield: number;
  sigma: number;
  years: number;
  days: number;
}
/** The Black-Scholes derivation behind one contract's Greeks. */
export interface Working {
  kind: OptionKind;
  inputs: WorkingInputs;
  terms: WorkingTerm[];
  greeks: WorkingTerm[];
}
export interface SignalDriver {
  label: string;
  detail: string;
  score: number;
  weight: number;
}
export interface OptionsSignal {
  fundamental: Nullable;
  momentum: Nullable;
  composite: number;
  direction: Direction;
  conviction: number;
  drivers: SignalDriver[];
}
export interface OptionsVolatility {
  realized30: Nullable;
  realized90: Nullable;
  realized252: Nullable;
  impliedAtm: Nullable;
  variancePremium: Nullable;
  forecast: number;
  regime: VolRegime;
}
export interface OptionsForecast {
  expiration: string;
  daysToExpiry: number;
  years: number;
  drift: number;
  expectedMove: number;
  expectedMovePercent: number;
  target: number;
  upper: number;
  lower: number;
  probabilityAboveSpot: number;
}
export interface OptionCandidate {
  contract: string;
  kind: OptionKind;
  expiration: string;
  strike: number;
  mid: number;
  bid: Nullable;
  ask: Nullable;
  spreadShare: Nullable;
  volume: Nullable;
  openInterest: Nullable;
  impliedVolatility: number;
  impliedSource: string;
  /** What one contract costs at the mid, in quote currency. */
  premium: number;
  /** Clears the minimum delta and fits inside the maximum premium. */
  eligible: boolean;
  greeks: Greeks;
  working: Working | null;
  modelValue: number;
  edge: number;
  liquidity: number;
  alignment: number;
  score: number;
  probabilityItm: number;
  breakeven: number;
}
export interface StrategyLeg {
  action: "buy" | "sell";
  contracts: number;
  contract: string;
  kind: OptionKind;
  expiration: string;
  strike: number;
  mid: number;
  impliedVolatility: number;
  greeks: Greeks;
  working: Working | null;
  openInterest: Nullable;
  spreadShare: Nullable;
}
export interface OptionStrategy {
  name: string;
  summary: string;
  rationale: string;
  direction: Direction;
  legs: StrategyLeg[];
  netDebit: number;
  maxProfit: Nullable;
  maxLoss: Nullable;
  capitalAtRisk: number;
  breakevens: number[];
  probabilityOfProfit: number;
  expectedProfit: number;
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
  netRho: number;
  score: number;
}
export interface OptionsOutlook {
  ticker: string;
  name: string;
  currency: string | null;
  spot: number;
  asOf: string;
  riskFreeRate: number;
  dividendYield: number;
  horizonDays: number;
  maxPremium: number;
  minDelta: number;
  signal: OptionsSignal;
  volatility: OptionsVolatility;
  forecast: OptionsForecast;
  recommendation: OptionStrategy;
  alternatives: OptionStrategy[];
  candidates: OptionCandidate[];
  expirations: string[];
  warnings: string[];
}
export interface OptionQuote {
  contract: string;
  expiration: string;
  strike: number;
  kind: OptionKind;
  bid: Nullable;
  ask: Nullable;
  last: Nullable;
  volume: Nullable;
  openInterest: Nullable;
  impliedVolatility: Nullable;
}
export interface OptionChain {
  ticker: string;
  spot: number;
  currency: string | null;
  fetchedAt: string;
  dividendYield: Nullable;
  expirations: string[];
  quotes: OptionQuote[];
  warnings: string[];
}
