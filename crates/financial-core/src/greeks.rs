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
