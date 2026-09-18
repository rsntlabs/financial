//! Greeks-driven options recommendation.
//!
//! The dashboard already knows two things the option chain does not: how the
//! business itself is trending (revenue, margins, cash generation) and what the
//! stock has actually done. This module turns those into a directional view,
//! compares the market's implied volatility with the stock's realized
//! volatility, and then uses the Greeks of every live contract to pick the
//! structure that expresses the view most efficiently. Nothing here is advice:
//! every number is a model output from the stated assumptions, and the
//! assumptions travel with the result.
use crate::greeks::{
    implied_volatility, norm_pdf, price, probability_above, probability_between, Greeks, Kind,
    CONTRACT_MULTIPLIER, DAYS_PER_YEAR,
};
use crate::{Point, Report};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const DEFAULT_HORIZON_DAYS: f64 = 45.0;
const DEFAULT_RISK_FREE_RATE: f64 = 0.04;
/// Widest sensible drift the directional view may imply, annualized.
const MAX_DRIFT: f64 = 0.30;
const MIN_CONTRACTS_PER_EXPIRY: usize = 4;
const TRADING_DAYS: f64 = 252.0;

fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}
fn squash(value: f64, scale: f64) -> f64 {
    finite(value).map_or(0.0, |v| (v / scale).tanh())
}
fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

// ---------------------------------------------------------------- inputs ----

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub contract: String,
    /// Expiry as `YYYY-MM-DD`.
    pub expiration: String,
    pub strike: f64,
    pub kind: Kind,
    #[serde(default)]
    pub bid: Option<f64>,
    #[serde(default)]
    pub ask: Option<f64>,
    #[serde(default)]
    pub last: Option<f64>,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub open_interest: Option<f64>,
    /// The provider's own implied volatility, as a decimal. Re-solved from the
    /// mid price when it is missing or implausible.
    #[serde(default)]
    pub implied_volatility: Option<f64>,
}
impl Quote {
    /// Mid price, falling back to the last trade when only one side is quoted.
    fn mid(&self) -> Option<f64> {
        match (self.bid.filter(|b| *b > 0.0), self.ask.filter(|a| *a > 0.0)) {
            (Some(bid), Some(ask)) if ask >= bid => Some(0.5 * (bid + ask)),
            (Some(bid), None) => Some(bid),
            (None, Some(ask)) => Some(ask),
            _ => self.last.filter(|l| *l > 0.0),
        }
        .and_then(finite)
    }
    /// Bid-ask spread as a share of the mid; a wide market is a real cost.
    fn spread_share(&self) -> Option<f64> {
        let (bid, ask, mid) = (self.bid?, self.ask?, self.mid()?);
        (ask >= bid && mid > 0.0).then(|| ((ask - bid) / mid).clamp(0.0, 1.0))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chain {
    pub ticker: String,
    pub spot: f64,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub fetched_at: String,
    #[serde(default)]
    pub dividend_yield: Option<f64>,
    #[serde(default)]
    pub expirations: Vec<String>,
    pub quotes: Vec<Quote>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricePoint {
    pub date: String,
    pub close: f64,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prices {
    #[serde(default)]
    pub points: Vec<PricePoint>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_horizon")]
    pub horizon_days: f64,
    #[serde(default = "default_rate")]
    pub risk_free_rate: f64,
    /// Overrides the chain's own dividend yield when supplied.
    #[serde(default)]
    pub dividend_yield: Option<f64>,
    /// Valuation date, `YYYY-MM-DD`. Defaults to the chain's fetch date.
    #[serde(default)]
    pub as_of: Option<String>,
}
fn default_horizon() -> f64 {
    DEFAULT_HORIZON_DAYS
}
fn default_rate() -> f64 {
    DEFAULT_RISK_FREE_RATE
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            horizon_days: DEFAULT_HORIZON_DAYS,
            risk_free_rate: DEFAULT_RISK_FREE_RATE,
            dividend_yield: None,
            as_of: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub report: Report,
    #[serde(default)]
    pub prices: Prices,
    pub chain: Chain,
    #[serde(default)]
    pub settings: Settings,
}

// --------------------------------------------------------------- outputs ----

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    pub label: String,
    pub detail: String,
    /// -1 (bearish) to +1 (bullish).
    pub score: f64,
    pub weight: f64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Bullish,
    Neutral,
    Bearish,
}
impl Direction {
    fn label(self) -> &'static str {
        match self {
            Direction::Bullish => "bullish",
            Direction::Neutral => "neutral",
            Direction::Bearish => "bearish",
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    pub fundamental: Option<f64>,
    pub momentum: Option<f64>,
    pub composite: f64,
    pub direction: Direction,
    /// 0 to 1; scales both the assumed drift and the size of the structure.
    pub conviction: f64,
    pub drivers: Vec<Driver>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VolRegime {
    Rich,
    Fair,
    Cheap,
}
impl VolRegime {
    fn label(self) -> &'static str {
        match self {
            VolRegime::Rich => "expensive",
            VolRegime::Fair => "fairly priced",
            VolRegime::Cheap => "cheap",
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volatility {
    pub realized30: Option<f64>,
    pub realized90: Option<f64>,
    pub realized252: Option<f64>,
    pub implied_atm: Option<f64>,
    /// Implied minus realized: what the market charges over recent movement.
    pub variance_premium: Option<f64>,
    pub forecast: f64,
    pub regime: VolRegime,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    pub expiration: String,
    pub days_to_expiry: f64,
    pub years: f64,
    pub drift: f64,
    pub expected_move: f64,
    pub expected_move_percent: f64,
    pub target: f64,
    pub upper: f64,
    pub lower: f64,
    pub probability_above_spot: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub contract: String,
    pub kind: Kind,
    pub expiration: String,
    pub strike: f64,
    pub mid: f64,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub spread_share: Option<f64>,
    pub volume: Option<f64>,
    pub open_interest: Option<f64>,
    pub implied_volatility: f64,
    pub implied_source: &'static str,
    pub greeks: Greeks,
    /// Model value under the forecast volatility, per share.
    pub model_value: f64,
    /// Model value minus mid, as a share of the mid.
    pub edge: f64,
    pub liquidity: f64,
    pub alignment: f64,
    pub score: f64,
    pub probability_itm: f64,
    pub breakeven: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leg {
    pub action: &'static str,
    pub contracts: u32,
    pub contract: String,
    pub kind: Kind,
    pub expiration: String,
    pub strike: f64,
    pub mid: f64,
    pub implied_volatility: f64,
    pub greeks: Greeks,
    pub open_interest: Option<f64>,
    pub spread_share: Option<f64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Strategy {
    pub name: &'static str,
    pub summary: String,
    pub rationale: String,
    pub direction: Direction,
    pub legs: Vec<Leg>,
    /// Positive when the structure costs money, negative when it collects it.
    pub net_debit: f64,
    pub max_profit: Option<f64>,
    pub max_loss: Option<f64>,
    pub capital_at_risk: f64,
    pub breakevens: Vec<f64>,
    pub probability_of_profit: f64,
    pub expected_profit: f64,
    pub net_delta: f64,
    pub net_gamma: f64,
    pub net_theta: f64,
    pub net_vega: f64,
    pub score: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outlook {
    pub ticker: String,
    pub name: String,
    pub currency: Option<String>,
    pub spot: f64,
    pub as_of: String,
    pub risk_free_rate: f64,
    pub dividend_yield: f64,
    pub horizon_days: f64,
    pub signal: Signal,
    pub volatility: Volatility,
    pub forecast: Forecast,
    pub recommendation: Strategy,
    pub alternatives: Vec<Strategy>,
    pub candidates: Vec<Candidate>,
    pub expirations: Vec<String>,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------- signal ----

/// The business itself: growth, its direction, margins and cash conversion.
fn fundamental_signal(report: &Report) -> (Option<f64>, Vec<Driver>) {
    let points: Vec<&Point> = report
        .points
        .iter()
        .filter(|p| p.revenue.is_some())
        .collect();
    let Some(latest) = points.last() else {
        return (None, Vec::new());
    };
    let mut drivers = Vec::new();
    let mut push = |label: &str, detail: String, score: f64, weight: f64| {
        drivers.push(Driver {
            label: label.into(),
            detail,
            score: score.clamp(-1.0, 1.0),
            weight,
        });
    };
    if let Some(growth) = latest.revenue_growth {
        push(
            "Revenue growth",
            format!("{:+.1}% in FY {}", growth * 100.0, latest.year),
            squash(growth, 0.15),
            0.28,
        );
        let prior: Vec<f64> = points[..points.len() - 1]
            .iter()
            .filter_map(|p| p.revenue_growth)
            .collect();
        if let Some(average) = mean(&prior) {
            push(
                "Growth trend",
                format!(
                    "{:+.1} points against the {:.1}% prior-year average",
                    (growth - average) * 100.0,
                    average * 100.0
                ),
                squash(growth - average, 0.08),
                0.16,
            );
        }
    }
    if let Some(margin) = latest.net_margin {
        push(
            "Net margin",
            format!("{:.1}% of revenue", margin * 100.0),
            squash(margin, 0.12),
            0.2,
        );
        if let Some(previous) = points.iter().rev().nth(1).and_then(|p| p.net_margin) {
            push(
                "Margin direction",
                format!("{:+.1} points year over year", (margin - previous) * 100.0),
                squash(margin - previous, 0.025),
                0.16,
            );
        }
    }
    if let (Some(fcf), Some(revenue)) = (latest.free_cash_flow, latest.revenue) {
        if revenue > 0.0 {
            push(
                "Free cash flow margin",
                format!("{:.1}% of revenue", fcf / revenue * 100.0),
                squash(fcf / revenue, 0.12),
                0.2,
            );
        }
    }
    (weighted(&drivers), drivers)
}

/// The tape: trailing returns and the distance from a long moving average.
fn momentum_signal(closes: &[f64]) -> (Option<f64>, Vec<Driver>) {
    let Some(last) = closes.last().copied().filter(|c| *c > 0.0) else {
        return (None, Vec::new());
    };
    let mut drivers = Vec::new();
    for (sessions, label, scale, weight) in [
        (21usize, "1-month return", 0.08, 0.26),
        (63, "3-month return", 0.14, 0.26),
        (126, "6-month return", 0.2, 0.2),
        (252, "12-month return", 0.3, 0.14),
    ] {
        let Some(base) = closes
            .len()
            .checked_sub(sessions + 1)
            .and_then(|i| closes.get(i))
            .filter(|c| **c > 0.0)
        else {
            continue;
        };
        let change = last / base - 1.0;
        drivers.push(Driver {
            label: label.into(),
            detail: format!("{:+.1}% over {sessions} sessions", change * 100.0),
            score: squash(change, scale).clamp(-1.0, 1.0),
            weight,
        });
    }
    if closes.len() > 200 {
        let average = mean(&closes[closes.len() - 200..]).unwrap_or(last);
        if average > 0.0 {
            drivers.push(Driver {
                label: "Trend".into(),
                detail: format!(
                    "{:+.1}% against the 200-session average",
                    (last / average - 1.0) * 100.0
                ),
                score: squash(last / average - 1.0, 0.08).clamp(-1.0, 1.0),
                weight: 0.14,
            });
        }
    }
    (weighted(&drivers), drivers)
}
fn weighted(drivers: &[Driver]) -> Option<f64> {
    let total: f64 = drivers.iter().map(|d| d.weight).sum();
    (total > 0.0)
        .then(|| drivers.iter().map(|d| d.score * d.weight).sum::<f64>() / total)
        .and_then(finite)
}

fn build_signal(report: &Report, closes: &[f64]) -> Signal {
    let (fundamental, mut drivers) = fundamental_signal(report);
    let (momentum, market) = momentum_signal(closes);
    drivers.extend(market);
    // Fundamentals set the thesis; the tape decides whether it is being priced
    // yet. Either one alone still produces a view, just a weaker one.
    let composite = match (fundamental, momentum) {
        (Some(f), Some(m)) => 0.55 * f + 0.45 * m,
        (Some(f), None) => 0.7 * f,
        (None, Some(m)) => 0.7 * m,
        (None, None) => 0.0,
    }
    .clamp(-1.0, 1.0);
    Signal {
        fundamental,
        momentum,
        composite,
        direction: if composite > 0.15 {
            Direction::Bullish
        } else if composite < -0.15 {
            Direction::Bearish
        } else {
            Direction::Neutral
        },
        conviction: composite.abs().clamp(0.0, 1.0),
        drivers,
    }
}

// ------------------------------------------------------------ volatility ----

/// Annualized close-to-close volatility over the last `sessions` returns.
fn realized_volatility(closes: &[f64], sessions: usize) -> Option<f64> {
    let returns: Vec<f64> = closes
        .windows(2)
        .filter(|w| w[0] > 0.0 && w[1] > 0.0)
        .map(|w| (w[1] / w[0]).ln())
        .collect();
    let window = returns.get(returns.len().checked_sub(sessions)?..)?;
    if window.len() < 10 {
        return None;
    }
    let average = mean(window)?;
    let variance =
        window.iter().map(|r| (r - average).powi(2)).sum::<f64>() / (window.len() - 1) as f64;
    finite((variance * TRADING_DAYS).sqrt()).filter(|v| *v > 0.0)
}

// ------------------------------------------------------------- structure ----

fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.get(..10)?, "%Y-%m-%d").ok()
}

/// Per-share profit at expiry across the whole position, before commissions.
fn profit(legs: &[Leg], net_debit_per_share: f64, spot: f64) -> f64 {
    legs.iter()
        .map(|leg| sign(leg) * f64::from(leg.contracts) * leg.kind.intrinsic(spot, leg.strike))
        .sum::<f64>()
        - net_debit_per_share
}
fn sign(leg: &Leg) -> f64 {
    if leg.action == "buy" {
        1.0
    } else {
        -1.0
    }
}

fn liquidity_score(quote: &Quote) -> f64 {
    let interest = quote.open_interest.unwrap_or(0.0).max(0.0);
    let volume = quote.volume.unwrap_or(0.0).max(0.0);
    let depth = ((interest + 2.0 * volume + 1.0).ln() / 8.0).clamp(0.0, 1.0);
    let spread = quote
        .spread_share()
        .map_or(0.4, |s| (1.0 - s / 0.4).clamp(0.0, 1.0));
    (0.55 * depth + 0.45 * spread).clamp(0.0, 1.0)
}

/// How well a contract expresses the view: a directional trade wants real
/// delta without paying for deep-in-the-money intrinsic value, while a neutral
/// view wants the wings.
fn alignment_score(direction: Direction, kind: Kind, delta: f64) -> f64 {
    let target =
        |ideal: f64, width: f64| (1.0 - (delta.abs() - ideal).abs() / width).clamp(0.0, 1.0);
    match (direction, kind) {
        (Direction::Bullish, Kind::Call) | (Direction::Bearish, Kind::Put) => target(0.55, 0.55),
        (Direction::Bullish, Kind::Put) | (Direction::Bearish, Kind::Call) => {
            // The opposite side is only interesting as a wing or short premium.
            0.35 * target(0.25, 0.35)
        }
        (Direction::Neutral, _) => target(0.28, 0.4),
    }
}

fn candidates(
    chain: &Chain,
    expiration: &str,
    market: &Assumptions,
    direction: Direction,
) -> Vec<Candidate> {
    let mut candidates: Vec<Candidate> = chain
        .quotes
        .iter()
        .filter(|q| q.expiration == expiration && q.strike > 0.0)
        .filter_map(|quote| {
            let mid = quote.mid()?;
            // Trust the provider's implied volatility only when it is a
            // plausible number; otherwise re-solve it from the mid price.
            let (sigma, source) = match quote
                .implied_volatility
                .filter(|v| v.is_finite() && (0.01..=5.0).contains(v))
            {
                Some(provided) => (provided, "provider"),
                None => (
                    implied_volatility(
                        quote.kind,
                        mid,
                        chain.spot,
                        quote.strike,
                        market.rate,
                        market.dividend_yield,
                        market.years,
                    )?,
                    "solved from mid",
                ),
            };
            let greeks = price(
                quote.kind,
                chain.spot,
                quote.strike,
                market.rate,
                market.dividend_yield,
                sigma,
                market.years,
            );
            let model = price(
                quote.kind,
                chain.spot,
                quote.strike,
                market.rate,
                market.dividend_yield,
                market.sigma,
                market.years,
            );
            let edge = ((model.value - mid) / mid).clamp(-2.0, 2.0);
            let liquidity = liquidity_score(quote);
            let alignment = alignment_score(direction, quote.kind, greeks.delta);
            let breakeven = match quote.kind {
                Kind::Call => quote.strike + mid,
                Kind::Put => quote.strike - mid,
            };
            Some(Candidate {
                contract: quote.contract.clone(),
                kind: quote.kind,
                expiration: quote.expiration.clone(),
                strike: quote.strike,
                mid,
                bid: quote.bid,
                ask: quote.ask,
                spread_share: quote.spread_share(),
                volume: quote.volume,
                open_interest: quote.open_interest,
                implied_volatility: sigma,
                implied_source: source,
                greeks,
                model_value: model.value,
                edge,
                liquidity,
                alignment,
                // Edge is the model's disagreement with the market; liquidity
                // and alignment decide whether it is tradeable and on-thesis.
                score: (0.4 * (0.5 + 0.5 * squash(edge, 0.15))
                    + 0.35 * alignment
                    + 0.25 * liquidity)
                    .clamp(0.0, 1.0),
                probability_itm: match quote.kind {
                    Kind::Call => probability_above(
                        chain.spot,
                        quote.strike,
                        market.drift,
                        market.sigma,
                        market.years,
                    ),
                    Kind::Put => {
                        1.0 - probability_above(
                            chain.spot,
                            quote.strike,
                            market.drift,
                            market.sigma,
                            market.years,
                        )
                    }
                },
                breakeven,
            })
        })
        .collect();
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    candidates
}

fn pick(candidates: &[Candidate], kind: Kind, delta: f64) -> Option<&Candidate> {
    candidates
        .iter()
        .filter(|c| c.kind == kind && c.mid > 0.0 && c.greeks.delta.abs() > 0.01)
        .min_by(|a, b| {
            let distance = |c: &Candidate| (c.greeks.delta - delta).abs();
            distance(a)
                .total_cmp(&distance(b))
                .then(b.liquidity.total_cmp(&a.liquidity))
        })
}
fn leg(action: &'static str, candidate: &Candidate, contracts: u32) -> Leg {
    Leg {
        action,
        contracts,
        contract: candidate.contract.clone(),
        kind: candidate.kind,
        expiration: candidate.expiration.clone(),
        strike: candidate.strike,
        mid: candidate.mid,
        implied_volatility: candidate.implied_volatility,
        greeks: candidate.greeks,
        open_interest: candidate.open_interest,
        spread_share: candidate.spread_share,
    }
}

/// Every pricing input the recommendation runs on, resolved once so each
/// contract, structure and probability is measured against the same model.
struct Assumptions {
    spot: f64,
    rate: f64,
    dividend_yield: f64,
    years: f64,
    /// Volatility the model prices with, blending implied and realized.
    sigma: f64,
    drift: f64,
}

/// Payoff analytics for an arbitrary combination of single-expiry legs. The
/// expiry payoff is piecewise linear with kinks only at the strikes, so the
/// extremes and breakevens are exact rather than sampled.
fn evaluate(
    name: &'static str,
    summary: String,
    rationale: String,
    direction: Direction,
    legs: Vec<Leg>,
    market: &Assumptions,
) -> Option<Strategy> {
    if legs.is_empty() || legs.iter().any(|l| !l.mid.is_finite() || l.mid <= 0.0) {
        return None;
    }
    let net_debit_share: f64 = legs
        .iter()
        .map(|l| sign(l) * f64::from(l.contracts) * l.mid)
        .sum();
    let mut kinks: Vec<f64> = legs.iter().map(|l| l.strike).collect();
    kinks.push(0.0);
    kinks.push((market.spot * 4.0).max(kinks.iter().fold(0.0, |a: f64, b| a.max(*b)) * 2.0));
    kinks.sort_by(f64::total_cmp);
    kinks.dedup();
    let payoff = |s: f64| profit(&legs, net_debit_share, s);
    let values: Vec<f64> = kinks.iter().map(|s| payoff(*s)).collect();
    // Beyond the last strike only calls still change value, so their net
    // quantity decides whether profit or loss runs away.
    let tail: f64 = legs
        .iter()
        .filter(|l| l.kind == Kind::Call)
        .map(|l| sign(l) * f64::from(l.contracts))
        .sum();
    let extreme = |best: bool| -> Option<f64> {
        if (best && tail > 0.0) || (!best && tail < 0.0) {
            return None;
        }
        values
            .iter()
            .copied()
            .fold(None, |acc: Option<f64>, v| {
                Some(acc.map_or(v, |a| if best { a.max(v) } else { a.min(v) }))
            })
            .map(|v| v * CONTRACT_MULTIPLIER)
    };
    let max_profit = extreme(true);
    let max_loss = extreme(false).map(|v| v.min(0.0));
    let mut breakevens = Vec::new();
    for (pair, level) in kinks.windows(2).zip(values.windows(2)) {
        if (level[0] <= 0.0) != (level[1] <= 0.0) && level[1] != level[0] {
            breakevens.push(pair[0] + (pair[1] - pair[0]) * (-level[0]) / (level[1] - level[0]));
        }
    }
    breakevens.retain(|b| b.is_finite() && *b > 0.0);
    breakevens.sort_by(f64::total_cmp);
    breakevens.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    // Profitable regions are the intervals between breakevens whose midpoint
    // pays; their lognormal mass is the probability of profit.
    let mut bounds = vec![0.0];
    bounds.extend(breakevens.iter().copied());
    bounds.push(f64::INFINITY);
    let probability_of_profit = bounds
        .windows(2)
        .filter(|w| {
            let probe = if w[1].is_finite() {
                0.5 * (w[0] + w[1])
            } else {
                w[0].max(market.spot) * 4.0
            };
            payoff(probe) > 0.0
        })
        .map(|w| {
            probability_between(
                market.spot,
                w[0],
                w[1],
                market.drift,
                market.sigma,
                market.years,
            )
        })
        .sum::<f64>()
        .clamp(0.0, 1.0);
    // Expected profit integrates the payoff against the same lognormal, in log
    // space so the tails are sampled evenly.
    let steps = 800;
    let width = 6.0 * market.sigma * market.years.sqrt();
    let center =
        market.spot.ln() + (market.drift - 0.5 * market.sigma * market.sigma) * market.years;
    let step = 2.0 * width / steps as f64;
    let mut expected = 0.0;
    for i in 0..=steps {
        let u = center - width + step * i as f64;
        let z = (u - center) / (market.sigma * market.years.sqrt());
        let weight = if i == 0 || i == steps { 0.5 } else { 1.0 };
        expected +=
            weight * payoff(u.exp()) * norm_pdf(z) * step / (market.sigma * market.years.sqrt());
    }
    let expected_profit = finite(expected * CONTRACT_MULTIPLIER).unwrap_or(0.0);
    let capital_at_risk = max_loss
        .map(f64::abs)
        .filter(|v| *v > 0.0)
        .unwrap_or(market.spot * CONTRACT_MULTIPLIER);
    let net = |value: fn(&Greeks) -> f64| -> f64 {
        legs.iter()
            .map(|l| sign(l) * f64::from(l.contracts) * value(&l.greeks) * CONTRACT_MULTIPLIER)
            .sum()
    };
    let liquidity = legs
        .iter()
        .map(|l| {
            let depth =
                ((l.open_interest.unwrap_or(0.0).max(0.0) + 1.0).ln() / 8.0).clamp(0.0, 1.0);
            let spread = l
                .spread_share
                .map_or(0.4, |s| (1.0 - s / 0.4).clamp(0.0, 1.0));
            0.5 * depth + 0.5 * spread
        })
        .sum::<f64>()
        / legs.len() as f64;
    Some(Strategy {
        name,
        summary,
        rationale,
        direction,
        net_debit: net_debit_share * CONTRACT_MULTIPLIER,
        max_profit,
        max_loss,
        capital_at_risk,
        breakevens,
        probability_of_profit,
        expected_profit,
        net_delta: net(|g| g.delta),
        net_gamma: net(|g| g.gamma),
        net_theta: net(|g| g.theta),
        net_vega: net(|g| g.vega),
        score: (0.45 * (0.5 + 0.5 * squash(expected_profit / capital_at_risk, 0.25))
            + 0.3 * probability_of_profit
            + 0.25 * liquidity)
            .clamp(0.0, 1.0),
        legs,
    })
}

fn money(value: f64) -> String {
    format!("{:.0}", value.abs())
}

/// Builds every structure that is consistent with the view, in the order the
/// volatility regime prefers them. Ranking then picks among them.
fn strategies(
    candidates: &[Candidate],
    signal: &Signal,
    volatility: &Volatility,
    market: &Assumptions,
) -> Vec<Strategy> {
    let (long_side, short_side, rich) = match signal.direction {
        Direction::Bearish => (Kind::Put, Kind::Call, volatility.regime == VolRegime::Rich),
        _ => (Kind::Call, Kind::Put, volatility.regime == VolRegime::Rich),
    };
    let mut built = Vec::new();
    let mut add = |strategy: Option<Strategy>| {
        if let Some(strategy) = strategy {
            built.push(strategy);
        }
    };
    let vol_note = match (
        volatility.implied_atm,
        volatility.realized30.or(volatility.realized90),
    ) {
        (Some(implied), Some(realized)) => format!(
            "At-the-money implied volatility of {:.0}% looks {} against {:.0}% realized.",
            implied * 100.0,
            volatility.regime.label(),
            realized * 100.0,
        ),
        (Some(implied), None) => format!(
            "At-the-money implied volatility is {:.0}%, with too little price history to compare it with realized movement.",
            implied * 100.0
        ),
        _ => format!(
            "No implied volatility was quoted; the model prices at {:.0}%.",
            volatility.forecast * 100.0
        ),
    };
    if signal.direction != Direction::Neutral {
        let bullish = signal.direction == Direction::Bullish;
        // Outright long premium: the cleanest expression when volatility is
        // not being overcharged.
        if let Some(long) = pick(candidates, long_side, if bullish { 0.6 } else { -0.6 }) {
            add(evaluate(
                if bullish { "Long call" } else { "Long put" },
                format!(
                    "Buy the {:.2} strike {} expiring {}",
                    long.strike,
                    long.kind.label(),
                    long.expiration
                ),
                format!(
                    "A {} view with {:.0}% conviction, expressed with {:+.2} delta per share and {} of premium at risk. {vol_note}",
                    signal.direction.label(),
                    signal.conviction * 100.0,
                    long.greeks.delta,
                    money(long.mid * CONTRACT_MULTIPLIER),
                ),
                signal.direction,
                vec![leg("buy", long, 1)],
                market,
            ));
            // Debit spread: caps the payoff but sells back part of the vega and
            // theta, which is what makes it the better trade when vol is rich.
            if let Some(short) = pick(candidates, long_side, if bullish { 0.28 } else { -0.28 }) {
                if (short.strike - long.strike).abs() > f64::EPSILON {
                    add(evaluate(
                        if bullish { "Bull call spread" } else { "Bear put spread" },
                        format!(
                            "Buy the {:.2} {} and sell the {:.2} {}, expiring {}",
                            long.strike,
                            long.kind.label(),
                            short.strike,
                            short.kind.label(),
                            long.expiration
                        ),
                        format!(
                            "Financing the long {} with a further out-of-the-money short one cuts the premium to {} and sells back most of the vega. {vol_note}",
                            long.kind.label(),
                            money((long.mid - short.mid) * CONTRACT_MULTIPLIER),
                        ),
                        signal.direction,
                        vec![leg("buy", long, 1), leg("sell", short, 1)],
                        market,
                    ));
                }
            }
        }
        // Credit spread on the opposite side: gets paid for the view and for
        // rich volatility, with defined risk.
        if let (Some(short), Some(wing)) = (
            pick(candidates, short_side, if bullish { -0.28 } else { 0.28 }),
            pick(candidates, short_side, if bullish { -0.14 } else { 0.14 }),
        ) {
            if (short.strike - wing.strike).abs() > f64::EPSILON {
                add(evaluate(
                    if bullish { "Bull put spread" } else { "Bear call spread" },
                    format!(
                        "Sell the {:.2} {} and buy the {:.2} {}, expiring {}",
                        short.strike,
                        short.kind.label(),
                        wing.strike,
                        wing.kind.label(),
                        short.expiration
                    ),
                    format!(
                        "Collects {} up front and profits while the stock stays {} {:.2}. {vol_note}",
                        money((short.mid - wing.mid) * CONTRACT_MULTIPLIER),
                        if bullish { "above" } else { "below" },
                        short.strike,
                    ),
                    signal.direction,
                    vec![leg("sell", short, 1), leg("buy", wing, 1)],
                    market,
                ));
            }
        }
    } else if rich {
        // No directional edge, but the market is overcharging for movement.
        if let (Some(short_put), Some(long_put), Some(short_call), Some(long_call)) = (
            pick(candidates, Kind::Put, -0.2),
            pick(candidates, Kind::Put, -0.1),
            pick(candidates, Kind::Call, 0.2),
            pick(candidates, Kind::Call, 0.1),
        ) {
            if long_put.strike < short_put.strike && short_call.strike < long_call.strike {
                add(evaluate(
                    "Iron condor",
                    format!(
                        "Sell the {:.2} put and {:.2} call, buy the {:.2} put and {:.2} call, expiring {}",
                        short_put.strike, short_call.strike, long_put.strike, long_call.strike, short_put.expiration
                    ),
                    format!(
                        "The fundamentals and the tape disagree, so the trade is the volatility, not the direction. {vol_note}"
                    ),
                    Direction::Neutral,
                    vec![
                        leg("sell", short_put, 1),
                        leg("buy", long_put, 1),
                        leg("sell", short_call, 1),
                        leg("buy", long_call, 1),
                    ],
                    market,
                ));
            }
        }
    } else if let (Some(call), Some(put)) = (
        pick(candidates, Kind::Call, 0.5),
        pick(candidates, Kind::Put, -0.5),
    ) {
        // Cheap volatility with no directional view: own the movement itself.
        add(evaluate(
            "Long straddle",
            format!(
                "Buy the {:.2} call and the {:.2} put, expiring {}",
                call.strike, put.strike, call.expiration
            ),
            format!(
                "No directional edge, but movement is cheap: {} of premium buys {:+.2} of gamma per share. {vol_note}",
                money((call.mid + put.mid) * CONTRACT_MULTIPLIER),
                call.greeks.gamma + put.greeks.gamma,
            ),
            Direction::Neutral,
            vec![leg("buy", call, 1), leg("buy", put, 1)],
            market,
        ));
    }
    // Rich volatility rewards the structures that are short premium, cheap
    // volatility the ones that are long it; the ranking below applies that.
    built.sort_by(|a, b| {
        let tilt = |s: &Strategy| {
            s.score
                + match volatility.regime {
                    VolRegime::Rich if s.net_vega < 0.0 => 0.08,
                    VolRegime::Cheap if s.net_vega > 0.0 => 0.08,
                    _ => 0.0,
                }
        };
        tilt(b).total_cmp(&tilt(a))
    });
    built
}

const CANDIDATE_LIMIT: usize = 16;
const ALTERNATIVE_LIMIT: usize = 3;

/// Turns a report, a price history and one option chain into a ranked
/// recommendation. Every assumption it makes is reported back in the result.
pub fn recommend(input: &Input) -> Result<Outlook, String> {
    let chain = &input.chain;
    if !chain.spot.is_finite() || chain.spot <= 0.0 {
        return Err("The option chain did not include a usable underlying price.".into());
    }
    let mut warnings = chain.warnings.clone();
    let mut closes: Vec<(String, f64)> = input
        .prices
        .points
        .iter()
        .filter(|p| p.close.is_finite() && p.close > 0.0)
        .map(|p| (p.date.clone(), p.close))
        .collect();
    closes.sort_by(|a, b| a.0.cmp(&b.0));
    let closes: Vec<f64> = closes.into_iter().map(|(_, c)| c).collect();
    if closes.len() < 30 {
        warnings.push(
            "Fewer than 30 daily closes are available, so realized volatility and momentum are limited or unavailable.".into(),
        );
    }
    let as_of = input
        .settings
        .as_of
        .as_deref()
        .and_then(parse_date)
        .or_else(|| parse_date(&chain.fetched_at))
        .ok_or("The option chain did not include a usable quote date.")?;
    let rate = finite(input.settings.risk_free_rate)
        .filter(|r| (-0.1..=0.5).contains(r))
        .unwrap_or(DEFAULT_RISK_FREE_RATE);
    let dividend_yield = input
        .settings
        .dividend_yield
        .or(chain.dividend_yield)
        .and_then(finite)
        .filter(|d| (0.0..=0.5).contains(d))
        .unwrap_or(0.0);
    let horizon = finite(input.settings.horizon_days)
        .filter(|d| (1.0..=1000.0).contains(d))
        .unwrap_or(DEFAULT_HORIZON_DAYS);

    // One expiry at a time: mixing expiries would mix different volatilities
    // and different amounts of time decay into the same payoff.
    let mut by_expiry: BTreeMap<String, usize> = BTreeMap::new();
    for quote in chain.quotes.iter().filter(|q| q.mid().is_some()) {
        *by_expiry.entry(quote.expiration.clone()).or_default() += 1;
    }
    let (expiration, days) = by_expiry
        .iter()
        .filter(|(_, count)| **count >= MIN_CONTRACTS_PER_EXPIRY)
        .filter_map(|(expiration, _)| {
            let days = (parse_date(expiration)? - as_of).num_days() as f64;
            (days >= 1.0).then(|| (expiration.clone(), days))
        })
        .min_by(|a, b| (a.1 - horizon).abs().total_cmp(&(b.1 - horizon).abs()))
        .ok_or("No expiration in this chain has enough quoted contracts to analyze.")?;
    if (days - horizon).abs() > 0.25 * horizon {
        warnings.push(format!(
            "The closest usable expiration is {days:.0} days out, against a {horizon:.0}-day horizon."
        ));
    }
    let years = (days / DAYS_PER_YEAR).max(1.0 / DAYS_PER_YEAR);

    let signal = build_signal(&input.report, &closes);
    // At-the-money implied volatility: the strike closest to spot on each side,
    // averaged, so a single stale quote cannot set the whole volatility view.
    let atm = |kind: Kind| -> Option<f64> {
        chain
            .quotes
            .iter()
            .filter(|q| q.expiration == expiration && q.kind == kind && q.strike > 0.0)
            .min_by(|a, b| {
                (a.strike - chain.spot)
                    .abs()
                    .total_cmp(&(b.strike - chain.spot).abs())
            })
            .and_then(|quote| {
                quote
                    .implied_volatility
                    .filter(|v| v.is_finite() && (0.01..=5.0).contains(v))
                    .or_else(|| {
                        implied_volatility(
                            kind,
                            quote.mid()?,
                            chain.spot,
                            quote.strike,
                            rate,
                            dividend_yield,
                            years,
                        )
                    })
            })
    };
    let implied_atm = match (atm(Kind::Call), atm(Kind::Put)) {
        (Some(call), Some(put)) => Some(0.5 * (call + put)),
        (single, None) | (None, single) => single,
    };
    let realized30 = realized_volatility(&closes, 30);
    let realized90 = realized_volatility(&closes, 90);
    let reference = realized30.or(realized90);
    let variance_premium = match (implied_atm, reference) {
        (Some(implied), Some(realized)) => Some(implied - realized),
        _ => None,
    };
    let regime = match (implied_atm, reference) {
        (Some(implied), Some(realized)) if realized > 0.0 && implied / realized > 1.15 => {
            VolRegime::Rich
        }
        (Some(implied), Some(realized)) if realized > 0.0 && implied / realized < 0.9 => {
            VolRegime::Cheap
        }
        _ => VolRegime::Fair,
    };
    let forecast_sigma = match (implied_atm, reference) {
        // The market's implied volatility is the price of movement; realized
        // volatility is the evidence. Blending them beats trusting either.
        (Some(implied), Some(realized)) => 0.6 * implied + 0.4 * realized,
        (Some(implied), None) => implied,
        (None, Some(realized)) => realized,
        (None, None) => {
            warnings.push(
                "Neither implied nor realized volatility was available; a 35% assumption was used."
                    .into(),
            );
            0.35
        }
    }
    .clamp(0.01, 5.0);
    let volatility = Volatility {
        realized30,
        realized90,
        realized252: realized_volatility(&closes, 252),
        implied_atm,
        variance_premium,
        forecast: forecast_sigma,
        regime,
    };
    let drift = (signal.composite * MAX_DRIFT).clamp(-MAX_DRIFT, MAX_DRIFT);
    let expected_move = chain.spot * forecast_sigma * years.sqrt();
    let target = chain.spot * (drift * years).exp();
    let forecast = Forecast {
        expiration: expiration.clone(),
        days_to_expiry: days,
        years,
        drift,
        expected_move,
        expected_move_percent: expected_move / chain.spot,
        target,
        upper: target + expected_move,
        lower: (target - expected_move).max(0.0),
        probability_above_spot: probability_above(
            chain.spot,
            chain.spot,
            drift,
            forecast_sigma,
            years,
        ),
    };
    let market = Assumptions {
        spot: chain.spot,
        rate,
        dividend_yield,
        years,
        sigma: forecast_sigma,
        drift,
    };
    let candidates = candidates(chain, &expiration, &market, signal.direction);
    if candidates.is_empty() {
        return Err("No contracts in this expiration carry a usable quote.".into());
    }
    let mut ranked = strategies(&candidates, &signal, &volatility, &market);
    if ranked.is_empty() {
        return Err(
            "The quoted strikes do not support a structure for this view. Try a different expiration.".into(),
        );
    }
    let recommendation = ranked.remove(0);
    ranked.truncate(ALTERNATIVE_LIMIT);
    warnings.push(format!(
        "Model assumptions: {:.1}% risk-free rate, {:.1}% dividend yield, {:.0}% forecast volatility, {:+.1}% annual drift from the {} view. Greeks are Black-Scholes values, not provider data.",
        rate * 100.0,
        dividend_yield * 100.0,
        forecast_sigma * 100.0,
        drift * 100.0,
        signal.direction.label(),
    ));
    warnings.push(
        "Model output from end-of-day data, not investment advice, and not a live quote. Options can expire worthless.".into(),
    );
    let mut shown = candidates;
    shown.truncate(CANDIDATE_LIMIT);
    Ok(Outlook {
        ticker: chain.ticker.clone(),
        name: input.report.name.clone(),
        currency: chain
            .currency
            .clone()
            .or_else(|| input.report.currency.clone()),
        spot: chain.spot,
        as_of: as_of.to_string(),
        risk_free_rate: rate,
        dividend_yield,
        horizon_days: horizon,
        signal,
        volatility,
        forecast,
        recommendation,
        alternatives: ranked,
        candidates: shown,
        expirations: chain.expirations.clone(),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::greeks::price;
    use serde_json::json;

    fn report(growth: f64, margin: f64) -> Report {
        let base = 1000.0;
        let points: Vec<_> = [2024, 2025]
            .iter()
            .enumerate()
            .map(|(i, year)| {
                let revenue = base * (1.0 + growth).powi(i as i32);
                json!({
                    "year": year, "end": format!("{year}-12-31"),
                    "revenue": revenue, "netIncome": revenue * margin,
                    "freeCashFlow": revenue * margin,
                    "revenueGrowth": (i > 0).then_some(growth),
                    "netMargin": margin,
                })
            })
            .collect();
        serde_json::from_value(json!({
            "ticker": "TEST", "name": "Test Industries", "currency": "USD",
            "years": [2024, 2025], "points": points
        }))
        .unwrap()
    }
    // A synthetic chain priced off Black-Scholes, so the engine's own Greeks
    // and the quotes agree and only the ranking logic is under test.
    fn chain(spot: f64, sigma: f64, expiration: &str, days: f64) -> Chain {
        let quotes = (-6..=6)
            .flat_map(|step| {
                let strike = (spot * (1.0 + f64::from(step) * 0.05)).round();
                [Kind::Call, Kind::Put].into_iter().map(move |kind| {
                    let value =
                        price(kind, spot, strike, 0.04, 0.0, sigma, days / DAYS_PER_YEAR).value;
                    Quote {
                        contract: format!("TEST{expiration}{}{strike}", kind.label()),
                        expiration: expiration.into(),
                        strike,
                        kind,
                        bid: Some((value * 0.98).max(0.01)),
                        ask: Some((value * 1.02).max(0.02)),
                        last: Some(value),
                        volume: Some(500.0),
                        open_interest: Some(2500.0),
                        implied_volatility: Some(sigma),
                    }
                })
            })
            .collect();
        Chain {
            ticker: "TEST".into(),
            spot,
            currency: Some("USD".into()),
            fetched_at: "2026-01-02T00:00:00Z".into(),
            dividend_yield: Some(0.0),
            expirations: vec![expiration.into()],
            quotes,
            warnings: vec![],
        }
    }
    // A deterministic random walk with a known annual drift and volatility, so
    // the realized-volatility and momentum paths are both exercised for real.
    fn prices(count: usize, annual_drift: f64, annual_vol: f64) -> Prices {
        let (mu, sigma) = (
            annual_drift / TRADING_DAYS,
            annual_vol / TRADING_DAYS.sqrt(),
        );
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut uniform = || {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((state >> 11) as f64 / (1u64 << 53) as f64).clamp(1e-12, 1.0 - 1e-12)
        };
        let mut close = 100.0;
        Prices {
            points: (0..count)
                .map(|i| {
                    let (u1, u2) = (uniform(), uniform());
                    let shock = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
                    close *= (mu - 0.5 * sigma * sigma + sigma * shock).exp();
                    PricePoint {
                        date: NaiveDate::from_ymd_opt(2024, 1, 1)
                            .unwrap()
                            .checked_add_days(chrono::Days::new(i as u64))
                            .unwrap()
                            .to_string(),
                        close,
                    }
                })
                .collect(),
        }
    }
    fn input(report: Report, prices: Prices, chain: Chain) -> Input {
        Input {
            report,
            prices,
            chain,
            settings: Settings {
                horizon_days: 45.0,
                risk_free_rate: 0.04,
                dividend_yield: Some(0.0),
                as_of: Some("2026-01-02".into()),
            },
        }
    }

    #[test]
    fn growing_company_in_an_uptrend_gets_a_bullish_long_premium_structure() {
        let outlook = recommend(&input(
            report(0.3, 0.2),
            prices(400, 0.8, 0.25),
            chain(100.0, 0.12, "2026-02-20", 49.0),
        ))
        .unwrap();
        assert_eq!(outlook.signal.direction, Direction::Bullish);
        assert!(outlook.signal.fundamental.unwrap() > 0.0);
        assert!(outlook.signal.momentum.unwrap() > 0.0);
        assert!(outlook.forecast.drift > 0.0 && outlook.forecast.target > outlook.spot);
        assert_eq!(outlook.forecast.expiration, "2026-02-20");
        // Implied volatility well under realized: long premium is the trade.
        assert_eq!(outlook.volatility.regime, VolRegime::Cheap);
        assert!(outlook.recommendation.net_vega > 0.0);
        assert!(
            outlook.recommendation.net_delta > 0.0,
            "{:?}",
            outlook.recommendation
        );
        assert!(outlook
            .recommendation
            .legs
            .iter()
            .any(|l| l.action == "buy" && l.kind == Kind::Call));
        assert!(outlook.candidates.iter().any(|c| c.edge > 0.0));
        assert!(!outlook.candidates.is_empty() && outlook.candidates.len() <= CANDIDATE_LIMIT);
        // Every candidate's Greeks must be self-consistent with its own quote.
        for candidate in &outlook.candidates {
            assert!(candidate.greeks.gamma >= 0.0 && candidate.greeks.vega >= 0.0);
            assert_eq!(candidate.kind == Kind::Call, candidate.greeks.delta > 0.0);
        }
    }
    #[test]
    fn shrinking_company_in_a_downtrend_gets_a_bearish_structure() {
        let outlook = recommend(&input(
            report(-0.25, -0.1),
            prices(400, -0.8, 0.25),
            chain(100.0, 0.3, "2026-02-20", 49.0),
        ))
        .unwrap();
        assert_eq!(outlook.signal.direction, Direction::Bearish);
        assert!(outlook.recommendation.net_delta < 0.0);
        assert!(outlook.forecast.drift < 0.0 && outlook.forecast.probability_above_spot < 0.5);
    }
    #[test]
    fn expensive_volatility_is_detected_and_tilts_the_ranking_short_vega() {
        // Quotes at 60% implied against a much calmer tape.
        let outlook = recommend(&input(
            report(0.3, 0.2),
            prices(400, 0.8, 0.2),
            chain(100.0, 0.6, "2026-02-20", 49.0),
        ))
        .unwrap();
        assert_eq!(outlook.volatility.regime, VolRegime::Rich);
        assert!(outlook.volatility.variance_premium.unwrap() > 0.0);
        assert!(
            outlook.recommendation.net_vega < 0.0
                || outlook.recommendation.name == "Bull call spread",
            "{}",
            outlook.recommendation.name
        );
    }
    #[test]
    fn payoff_analytics_match_a_hand_computed_vertical_spread() {
        let outlook = recommend(&input(
            report(0.3, 0.2),
            prices(400, 0.8, 0.25),
            chain(100.0, 0.3, "2026-02-20", 49.0),
        ))
        .unwrap();
        let spread = outlook
            .alternatives
            .iter()
            .chain(std::iter::once(&outlook.recommendation))
            .find(|s| s.name == "Bull call spread")
            .expect("a debit spread is always constructible from this chain");
        let [long, short] = &spread.legs[..] else {
            panic!("a vertical spread has two legs")
        };
        let width = (short.strike - long.strike) * CONTRACT_MULTIPLIER;
        let debit = (long.mid - short.mid) * CONTRACT_MULTIPLIER;
        assert!((spread.net_debit - debit).abs() < 1e-6);
        assert!((spread.max_profit.unwrap() - (width - debit)).abs() < 1e-6);
        assert!((spread.max_loss.unwrap() + debit).abs() < 1e-6);
        assert_eq!(spread.breakevens.len(), 1);
        assert!((spread.breakevens[0] - (long.strike + debit / CONTRACT_MULTIPLIER)).abs() < 1e-6);
        assert!((0.0..=1.0).contains(&spread.probability_of_profit));
        // Long call, short call of the same expiry: positive delta, negative
        // theta bleed bounded by the short leg.
        assert!(spread.net_delta > 0.0 && spread.net_gamma > 0.0);
    }
    #[test]
    fn rejects_unusable_chains_and_falls_back_to_solved_implied_volatility() {
        let mut broken = chain(100.0, 0.3, "2026-02-20", 49.0);
        broken.spot = 0.0;
        assert!(recommend(&input(report(0.3, 0.2), prices(400, 0.8, 0.25), broken)).is_err());
        let mut expired = chain(100.0, 0.3, "2025-06-20", 49.0);
        expired.expirations = vec!["2025-06-20".into()];
        assert!(recommend(&input(report(0.3, 0.2), prices(400, 0.8, 0.25), expired)).is_err());
        let mut unpriced = chain(100.0, 0.3, "2026-02-20", 49.0);
        for quote in &mut unpriced.quotes {
            quote.implied_volatility = Some(99.0);
        }
        let outlook =
            recommend(&input(report(0.3, 0.2), prices(400, 0.8, 0.25), unpriced)).unwrap();
        assert!(outlook
            .candidates
            .iter()
            .all(|c| c.implied_source == "solved from mid"));
        assert!(outlook
            .candidates
            .iter()
            .all(|c| (c.implied_volatility - 0.3).abs() < 0.02));
    }
}
