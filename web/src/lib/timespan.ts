/**
 * The dashboard's one time span.
 *
 * The panels that look backwards used to carry a period control each — fiscal
 * years in the toolbar, a price range on the chart — so one screen could show
 * two different windows at once and neither said so. They read a span from
 * here instead: the user says how far back they are looking, once, and each
 * panel takes the part of that window it can use. Statements arrive as whole
 * fiscal years and only 3, 5 or 10 of them are reliably sourced, so every span
 * shorter than five years settles on the shortest statement window, while
 * daily closes are charted for the span itself.
 *
 * The Options tab is deliberately outside this. Its horizon looks forward, to
 * an expiration the chain has to actually list, and is chosen per analysis
 * rather than per view, so it stays the panel's own control.
 */
export type TimeSpanId =
  "1M" | "3M" | "6M" | "1Y" | "3Y" | "5Y" | "10Y" | "MAX";

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
}

export const TIME_SPANS: readonly TimeSpan[] = [
  {
    id: "1M",
    label: "1 month",
    short: "1M",
    years: 3,
    months: 1,
  },
  {
    id: "3M",
    label: "3 months",
    short: "3M",
    years: 3,
    months: 3,
  },
  {
    id: "6M",
    label: "6 months",
    short: "6M",
    years: 3,
    months: 6,
  },
  {
    id: "1Y",
    label: "1 year",
    short: "1Y",
    years: 3,
    months: 12,
  },
  {
    id: "3Y",
    label: "3 years",
    short: "3Y",
    years: 3,
    months: 36,
  },
  {
    id: "5Y",
    label: "5 years",
    short: "5Y",
    years: 5,
    months: 60,
  },
  {
    id: "10Y",
    label: "10 years",
    short: "10Y",
    years: 10,
    months: 120,
  },
  {
    id: "MAX",
    label: "Maximum",
    short: "Max",
    years: 10,
    months: 0,
  },
];

/**
 * Three fiscal years of statements and three years of closes: the statement
 * window Yahoo's free data reliably covers, which is what the rest of the
 * dashboard was already defaulting to.
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

/**
 * What the chosen span means for each panel, stated under the control so the
 * one window is legible where the several used to be.
 */
export function spanSummary(span: TimeSpan): string {
  const prices =
    span.months === 0
      ? "every saved daily close"
      : `${span.label} of daily closes`;
  return `${span.years} fiscal years of statements · ${prices}`;
}
