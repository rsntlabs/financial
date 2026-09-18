//! Black-Scholes-Merton pricing, Greeks and implied volatility.
//!
//! Units follow the convention option desks quote: delta and gamma per one
//! unit of spot, vega per one volatility *point* (0.01), theta per calendar
//! day, rho per one percentage point of the risk-free rate. Every function is
//! total: degenerate inputs (expired, zero volatility, nonpositive spot or
//! strike) fall back to the discounted intrinsic value rather than producing
//! NaN, so a malformed provider quote can never poison a recommendation.
use serde::{Deserialize, Serialize};

pub const DAYS_PER_YEAR: f64 = 365.0;
/// Shares represented by one listed equity option contract.
pub const CONTRACT_MULTIPLIER: f64 = 100.0;
const MIN_SIGMA: f64 = 0.005;
const MAX_SIGMA: f64 = 5.0;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Call,
    Put,
}
impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Call => "call",
            Kind::Put => "put",
        }
    }
    /// Value at expiry, per share.
    pub fn intrinsic(self, spot: f64, strike: f64) -> f64 {
        match self {
            Kind::Call => (spot - strike).max(0.0),
            Kind::Put => (strike - spot).max(0.0),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Greeks {
    pub value: f64,
    pub delta: f64,
    pub gamma: f64,
    /// Per calendar day, as a negative number for long premium.
    pub theta: f64,
    /// Per one volatility point (a move from 30% to 31%).
    pub vega: f64,
    /// Per one percentage point of the risk-free rate.
    pub rho: f64,
}

/// Abramowitz & Stegun 7.1.26; ~1.5e-7 absolute error, far inside the noise of
/// any option quote.
fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let poly = t
        * (0.254_829_592
            + t * (-0.284_496_736
                + t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429))));
    sign * (1.0 - poly * (-x * x).exp())
}
pub fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / std::f64::consts::SQRT_2))
}
pub fn norm_pdf(x: f64) -> f64 {
    (-0.5 * x * x).exp() / (2.0 * std::f64::consts::PI).sqrt()
}

/// `rate` and `dividend_yield` are continuous annual rates; `years` is the time
/// to expiry in calendar years.
pub fn price(
    kind: Kind,
    spot: f64,
    strike: f64,
    rate: f64,
    dividend_yield: f64,
    sigma: f64,
    years: f64,
) -> Greeks {
    if !(spot.is_finite() && strike.is_finite() && spot > 0.0 && strike > 0.0) {
        return Greeks::default();
    }
    if !(years.is_finite() && sigma.is_finite()) || years <= 0.0 || sigma < MIN_SIGMA {
        // Expired or volatility-free: worth its discounted intrinsic value, and
        // delta is the only Greek that survives.
        let forward = spot * ((rate - dividend_yield) * years.max(0.0)).exp();
        let intrinsic = kind.intrinsic(forward, strike) * (-rate * years.max(0.0)).exp();
        let live = kind.intrinsic(forward, strike) > 0.0;
        return Greeks {
            value: intrinsic,
            delta: match (kind, live) {
                (Kind::Call, true) => 1.0,
                (Kind::Put, true) => -1.0,
                _ => 0.0,
            },
            ..Greeks::default()
        };
    }
    let sqrt_t = years.sqrt();
    let d1 = ((spot / strike).ln() + (rate - dividend_yield + 0.5 * sigma * sigma) * years)
        / (sigma * sqrt_t);
    let d2 = d1 - sigma * sqrt_t;
    let discount = (-rate * years).exp();
    let carry = (-dividend_yield * years).exp();
    let pdf = norm_pdf(d1);
    let gamma = carry * pdf / (spot * sigma * sqrt_t);
    let vega = spot * carry * pdf * sqrt_t / 100.0;
    let (value, delta, theta, rho) = match kind {
        Kind::Call => {
            let value = spot * carry * norm_cdf(d1) - strike * discount * norm_cdf(d2);
            let theta = -spot * carry * pdf * sigma / (2.0 * sqrt_t)
                - rate * strike * discount * norm_cdf(d2)
                + dividend_yield * spot * carry * norm_cdf(d1);
            (
                value,
                carry * norm_cdf(d1),
                theta,
                strike * years * discount * norm_cdf(d2) / 100.0,
            )
        }
        Kind::Put => {
            let value = strike * discount * norm_cdf(-d2) - spot * carry * norm_cdf(-d1);
            let theta = -spot * carry * pdf * sigma / (2.0 * sqrt_t)
                + rate * strike * discount * norm_cdf(-d2)
                - dividend_yield * spot * carry * norm_cdf(-d1);
            (
                value,
                -carry * norm_cdf(-d1),
                theta,
                -strike * years * discount * norm_cdf(-d2) / 100.0,
            )
        }
    };
    Greeks {
        value: value.max(0.0),
        delta,
        gamma,
        theta: theta / DAYS_PER_YEAR,
        vega,
        rho,
    }
}

/// One line of the Black-Scholes working: the symbol, the formula as written,
/// the same formula with this contract's numbers in it, and the result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Term {
    pub symbol: &'static str,
    pub formula: &'static str,
    pub substituted: String,
    pub value: f64,
    pub unit: &'static str,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inputs {
    pub spot: f64,
    pub strike: f64,
    pub rate: f64,
    pub dividend_yield: f64,
    pub sigma: f64,
    pub years: f64,
    pub days: f64,
}
/// The full derivation behind one contract's Greeks: the inputs, the
/// intermediate terms every Greek shares, and each Greek's own formula. The
/// numbers come from the same code path as `price`, so what the panel shows is
/// what the ranking used, not a re-derivation that could drift from it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workings {
    pub kind: Kind,
    pub inputs: Inputs,
    pub terms: Vec<Term>,
    pub greeks: Vec<Term>,
}

fn term(symbol: &'static str, formula: &'static str, substituted: String, value: f64) -> Term {
    Term {
        symbol,
        formula,
        substituted,
        value,
        unit: "",
    }
}
fn measured(
    symbol: &'static str,
    formula: &'static str,
    substituted: String,
    value: f64,
    unit: &'static str,
) -> Term {
    Term {
        symbol,
        formula,
        substituted,
        value,
        unit,
    }
}

/// Shows the arithmetic behind `price` for one contract. Degenerate inputs have
/// no derivation to show, so they report none.
pub fn workings(
    kind: Kind,
    spot: f64,
    strike: f64,
    rate: f64,
    dividend_yield: f64,
    sigma: f64,
    years: f64,
) -> Option<Workings> {
    if !(spot > 0.0 && strike > 0.0 && years > 0.0 && sigma >= MIN_SIGMA)
        || !(spot.is_finite() && strike.is_finite() && years.is_finite() && sigma.is_finite())
    {
        return None;
    }
    let (s, k, q, t) = (spot, strike, dividend_yield, years);
    let sqrt_t = t.sqrt();
    let d1 = ((s / k).ln() + (rate - q + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t);
    let d2 = d1 - sigma * sqrt_t;
    let discount = (-rate * t).exp();
    let carry = (-q * t).exp();
    let pdf = norm_pdf(d1);
    let computed = price(kind, s, k, rate, q, sigma, t);
    let call = kind == Kind::Call;
    // N(d) for a call, N(-d) for a put: the same derivation mirrored.
    let (nd1, nd2) = if call {
        (norm_cdf(d1), norm_cdf(d2))
    } else {
        (norm_cdf(-d1), norm_cdf(-d2))
    };
    let terms = vec![
        term(
            "d₁",
            "[ln(S / K) + (r − q + σ² / 2) · T] / (σ · √T)",
            format!(
                "[ln({s:.2} / {k:.2}) + ({rate:.4} − {q:.4} + {:.4} / 2) · {t:.4}] / ({sigma:.4} · {sqrt_t:.4})",
                sigma * sigma
            ),
            d1,
        ),
        term(
            "d₂",
            "d₁ − σ · √T",
            format!("{d1:.4} − {sigma:.4} · {sqrt_t:.4}"),
            d2,
        ),
        term(
            if call { "N(d₁)" } else { "N(−d₁)" },
            "Standard normal CDF",
            format!("N({}{:.4})", if call { "" } else { "−" }, if call { d1 } else { -d1 }),
            nd1,
        ),
        term(
            if call { "N(d₂)" } else { "N(−d₂)" },
            "Standard normal CDF",
            format!("N({}{:.4})", if call { "" } else { "−" }, if call { d2 } else { -d2 }),
            nd2,
        ),
        term(
            "φ(d₁)",
            "Standard normal PDF",
            format!("e^(−{:.4} / 2) / √(2π)", d1 * d1),
            pdf,
        ),
        term(
            "e^(−q · T)",
            "Dividend carry factor",
            format!("e^(−{q:.4} · {t:.4})"),
            carry,
        ),
        term(
            "e^(−r · T)",
            "Discount factor",
            format!("e^(−{rate:.4} · {t:.4})"),
            discount,
        ),
    ];
    let greeks = vec![
        measured(
            if call { "Value (C)" } else { "Value (P)" },
            if call {
                "C = S · e^(−q · T) · N(d₁) − K · e^(−r · T) · N(d₂)"
            } else {
                "P = K · e^(−r · T) · N(−d₂) − S · e^(−q · T) · N(−d₁)"
            },
            if call {
                format!("{s:.2} · {carry:.4} · {nd1:.4} − {k:.2} · {discount:.4} · {nd2:.4}")
            } else {
                format!("{k:.2} · {discount:.4} · {nd2:.4} − {s:.2} · {carry:.4} · {nd1:.4}")
            },
            computed.value,
            "per share",
        ),
        measured(
            "Delta (Δ)",
            if call {
                "Δ = e^(−q · T) · N(d₁)"
            } else {
                "Δ = −e^(−q · T) · N(−d₁)"
            },
            format!("{}{carry:.4} · {nd1:.4}", if call { "" } else { "−" }),
            computed.delta,
            "per 1.00 of spot",
        ),
        measured(
            "Gamma (Γ)",
            "Γ = e^(−q · T) · φ(d₁) / (S · σ · √T)",
            format!("{carry:.4} · {pdf:.4} / ({s:.2} · {sigma:.4} · {sqrt_t:.4})"),
            computed.gamma,
            "delta per 1.00 of spot",
        ),
        measured(
            "Theta (Θ)",
            if call {
                "Θ = [−S · e^(−q · T) · φ(d₁) · σ / (2 · √T) − r · K · e^(−r · T) · N(d₂) + q · S · e^(−q · T) · N(d₁)] / 365"
            } else {
                "Θ = [−S · e^(−q · T) · φ(d₁) · σ / (2 · √T) + r · K · e^(−r · T) · N(−d₂) − q · S · e^(−q · T) · N(−d₁)] / 365"
            },
            format!(
                "[−{s:.2} · {carry:.4} · {pdf:.4} · {sigma:.4} / (2 · {sqrt_t:.4}) {} {rate:.4} · {k:.2} · {discount:.4} · {nd2:.4} {} {q:.4} · {s:.2} · {carry:.4} · {nd1:.4}] / {DAYS_PER_YEAR:.0}",
                if call { "−" } else { "+" },
                if call { "+" } else { "−" },
            ),
            computed.theta,
            "per calendar day",
        ),
        measured(
            "Vega (ν)",
            "ν = S · e^(−q · T) · φ(d₁) · √T / 100",
            format!("{s:.2} · {carry:.4} · {pdf:.4} · {sqrt_t:.4} / 100"),
            computed.vega,
            "per volatility point",
        ),
        measured(
            "Rho (ρ)",
            if call {
                "ρ = K · T · e^(−r · T) · N(d₂) / 100"
            } else {
                "ρ = −K · T · e^(−r · T) · N(−d₂) / 100"
            },
            format!(
                "{}{k:.2} · {t:.4} · {discount:.4} · {nd2:.4} / 100",
                if call { "" } else { "−" }
            ),
            computed.rho,
            "per rate point",
        ),
    ];
    Some(Workings {
        kind,
        inputs: Inputs {
            spot: s,
            strike: k,
            rate,
            dividend_yield: q,
            sigma,
            years: t,
            days: t * DAYS_PER_YEAR,
        },
        terms,
        greeks,
    })
}

/// Bisection: monotone in sigma, so it always converges, and it cannot diverge
/// the way Newton does on a deep out-of-the-money quote with vega near zero.
/// Returns `None` when the market price violates the no-arbitrage bounds.
pub fn implied_volatility(
    kind: Kind,
    market: f64,
    spot: f64,
    strike: f64,
    rate: f64,
    dividend_yield: f64,
    years: f64,
) -> Option<f64> {
    if !(market.is_finite() && market > 0.0) || years <= 0.0 || spot <= 0.0 || strike <= 0.0 {
        return None;
    }
    let value = |sigma| price(kind, spot, strike, rate, dividend_yield, sigma, years).value;
    if market <= value(MIN_SIGMA) || market >= value(MAX_SIGMA) {
        return None;
    }
    let (mut low, mut high) = (MIN_SIGMA, MAX_SIGMA);
    for _ in 0..80 {
        let mid = 0.5 * (low + high);
        if value(mid) < market {
            low = mid;
        } else {
            high = mid;
        }
    }
    Some(0.5 * (low + high))
}

/// Probability that a lognormal spot ends above `target`, under an annual
/// drift `drift` and volatility `sigma`.
pub fn probability_above(spot: f64, target: f64, drift: f64, sigma: f64, years: f64) -> f64 {
    if spot <= 0.0 || years <= 0.0 || sigma <= 0.0 {
        return f64::from(u8::from(spot > target));
    }
    if target <= 0.0 {
        return 1.0;
    }
    let d = ((spot / target).ln() + (drift - 0.5 * sigma * sigma) * years) / (sigma * years.sqrt());
    norm_cdf(d)
}
pub fn probability_between(spot: f64, low: f64, high: f64, drift: f64, sigma: f64, t: f64) -> f64 {
    (probability_above(spot, low, drift, sigma, t) - probability_above(spot, high, drift, sigma, t))
        .clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn close(a: f64, b: f64, tolerance: f64) -> bool {
        (a - b).abs() <= tolerance
    }
    #[test]
    fn prices_match_published_black_scholes_values_and_put_call_parity() {
        // S=100, K=100, r=5%, sigma=20%, T=1: the textbook call is 10.4506.
        let call = price(Kind::Call, 100.0, 100.0, 0.05, 0.0, 0.2, 1.0);
        let put = price(Kind::Put, 100.0, 100.0, 0.05, 0.0, 0.2, 1.0);
        assert!(close(call.value, 10.4506, 1e-3), "{}", call.value);
        assert!(close(put.value, 5.5735, 1e-3), "{}", put.value);
        // C - P = S - K e^{-rT}
        assert!(close(
            call.value - put.value,
            100.0 - 100.0 * (-0.05f64).exp(),
            1e-3
        ));
        assert!(close(call.delta, 0.6368, 1e-3), "{}", call.delta);
        assert!(close(put.delta, call.delta - 1.0, 1e-3));
        assert!(close(call.gamma, put.gamma, 1e-9));
        assert!(close(call.vega, put.vega, 1e-9) && call.vega > 0.0);
        assert!(call.theta < 0.0 && put.theta < 0.0);
    }
    #[test]
    fn degenerate_inputs_fall_back_to_intrinsic_value() {
        let expired = price(Kind::Call, 120.0, 100.0, 0.05, 0.0, 0.3, 0.0);
        assert_eq!(
            (expired.value, expired.delta, expired.vega),
            (20.0, 1.0, 0.0)
        );
        let worthless = price(Kind::Put, 120.0, 100.0, 0.05, 0.0, 0.0, 0.25);
        assert_eq!((worthless.value, worthless.delta), (0.0, 0.0));
        assert_eq!(
            price(Kind::Call, -1.0, 100.0, 0.05, 0.0, 0.3, 1.0).value,
            0.0
        );
    }
    #[test]
    fn implied_volatility_inverts_pricing_and_rejects_impossible_quotes() {
        let sigma = 0.37;
        let quoted = price(Kind::Put, 95.0, 100.0, 0.04, 0.01, sigma, 0.25).value;
        let solved = implied_volatility(Kind::Put, quoted, 95.0, 100.0, 0.04, 0.01, 0.25).unwrap();
        assert!(close(solved, sigma, 1e-4), "{solved}");
        assert!(implied_volatility(Kind::Call, 1e9, 95.0, 100.0, 0.04, 0.0, 0.25).is_none());
        assert!(implied_volatility(Kind::Call, 0.0, 95.0, 100.0, 0.04, 0.0, 0.25).is_none());
    }
    #[test]
    fn the_shown_working_is_the_same_arithmetic_the_ranking_used() {
        let (s, k, r, q, sigma, t) = (100.0, 105.0, 0.04, 0.01, 0.28, 0.25);
        for kind in [Kind::Call, Kind::Put] {
            let computed = price(kind, s, k, r, q, sigma, t);
            let shown = workings(kind, s, k, r, q, sigma, t).unwrap();
            // Every Greek in the panel is the value the engine ranked on.
            let value = |symbol: &str| {
                shown
                    .greeks
                    .iter()
                    .find(|g| g.symbol.starts_with(symbol))
                    .unwrap()
                    .value
            };
            assert_eq!(value("Value"), computed.value);
            assert_eq!(value("Delta"), computed.delta);
            assert_eq!(value("Gamma"), computed.gamma);
            assert_eq!(value("Theta"), computed.theta);
            assert_eq!(value("Vega"), computed.vega);
            assert_eq!(value("Rho"), computed.rho);
            // The intermediate terms are the ones the formulas above refer to.
            let d1 = shown.terms[0].value;
            assert!(close(shown.terms[1].value, d1 - sigma * t.sqrt(), 1e-12));
            assert!(close(shown.terms[6].value, (-r * t).exp(), 1e-12));
            assert_eq!(shown.inputs.days, t * DAYS_PER_YEAR);
            for line in shown.terms.iter().chain(&shown.greeks) {
                assert!(!line.formula.is_empty() && line.substituted.contains(char::is_numeric));
            }
        }
        // Nothing to derive for an expired or volatility-free contract.
        assert!(workings(Kind::Call, s, k, r, q, sigma, 0.0).is_none());
        assert!(workings(Kind::Call, s, k, r, q, 0.0, t).is_none());
    }
    #[test]
    fn lognormal_probabilities_bracket_the_forward() {
        // A driftless median sits at the spot, so half the mass is above it.
        assert!(close(
            probability_above(100.0, 100.0, 0.5 * 0.2 * 0.2, 0.2, 1.0),
            0.5,
            1e-6
        ));
        assert!(probability_above(100.0, 200.0, 0.0, 0.2, 1.0) < 0.01);
        assert!(close(
            probability_between(100.0, 0.0, f64::INFINITY, 0.0, 0.2, 1.0),
            1.0,
            1e-6
        ));
    }
}
