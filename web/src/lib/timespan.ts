/**
 * The dashboard's one time span.
 *
 * Every panel used to carry a period control of its own — fiscal years in the
 * toolbar, a price range on the chart, an expiration horizon on the options
 * tab — so one screen could show three different windows at once and none of
 * them said so. They all read a span from here instead: the user says how far
 * back they are looking, once, and each panel takes the part of that window it
 * can use.
 *
 * The parts differ because the data does. Statements arrive as whole fiscal
 * years and only 3, 5 or 10 of them are reliably sourced, so every span
 * shorter than five years settles on the shortest statement window; daily
 * closes are charted for the span itself; and the option chain is read as far
 * forward as the span reaches back, capped at the two-year LEAPS that Yahoo
 * lists as the longest expiration.
 */
export type TimeSpanId =
  | "1M"
  | "3M"
  | "6M"
  | "1Y"
  | "3Y"
  | "5Y"
  | "10Y"
  | "MAX";

export interface TimeSpan {
  id: TimeSpanId;
  /** The full name, for prose and the control's accessible names. */
  label: string;
  /** The compact name the segmented control shows. */
  short: string;
  /** Fiscal years of statements the analysis covers. */
  years: number;
  /** Months of daily closes to chart; 0 is every session on record. */
  months: number;
  /** How far forward the option chain is read, in days. */
  horizonDays: number;
}

/** The longest expiration Yahoo lists, so the horizon stops here. */
export const LEAPS_DAYS = 730;

export const TIME_SPANS: readonly TimeSpan[] = [
  {
    id: "1M",
    label: "1 month",
    short: "1M",
    years: 3,
    months: 1,
    horizonDays: 30,
  },
  {
    id: "3M",
    label: "3 months",
    short: "3M",
    years: 3,
    months: 3,
    horizonDays: 90,
  },
  {
    id: "6M",
    label: "6 months",
    short: "6M",
    years: 3,
    months: 6,
    horizonDays: 180,
  },
  {
    id: "1Y",
    label: "1 year",
    short: "1Y",
    years: 3,
    months: 12,
    horizonDays: 365,
  },
  {
    id: "3Y",
    label: "3 years",
    short: "3Y",
    years: 3,
    months: 36,
    horizonDays: LEAPS_DAYS,
  },
  {
    id: "5Y",
    label: "5 years",
    short: "5Y",
    years: 5,
    months: 60,
    horizonDays: LEAPS_DAYS,
  },
  {
    id: "10Y",
    label: "10 years",
    short: "10Y",
    years: 10,
    months: 120,
    horizonDays: LEAPS_DAYS,
  },
  {
    id: "MAX",
    label: "Maximum",
    short: "Max",
    years: 10,
    months: 0,
    horizonDays: LEAPS_DAYS,
  },
];

/**
 * Three fiscal years of statements, three years of closes and the LEAPS: the
 * statement window Yahoo's free data reliably covers, which is what the rest
 * of the dashboard was already defaulting to.
 */
export const DEFAULT_TIME_SPAN: TimeSpanId = "3Y";

export function timeSpan(id: TimeSpanId): TimeSpan {
  return (
    TIME_SPANS.find((span) => span.id === id) ??
    TIME_SPANS.find((span) => span.id === DEFAULT_TIME_SPAN)!
  );
}

/** How the price chart describes the window it is drawing. */
export function priceWindow(span: TimeSpan): string {
  return span.months === 0 ? "All saved sessions" : `Last ${span.label}`;
}

/** How far out the option chain is read, in the units a trader would say it. */
export function horizonLabel(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? "1 year" : `${years} years`;
  }
  if (days % 30 === 0) {
    const months = days / 30;
    return months === 1 ? "1 month" : `${months} months`;
  }
  return `${days} days`;
}

/**
 * What the chosen span means for each panel, stated under the control so the
 * one window is legible where the several used to be.
 */
export function spanSummary(span: TimeSpan): string {
  const prices =
    span.months === 0
      ? "every saved daily close"
      : `${span.label} of daily closes`;
  return `${span.years} fiscal years of statements · ${prices} · option expirations nearest ${horizonLabel(span.horizonDays)} out`;
}
