export type Nullable = number | null;
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
