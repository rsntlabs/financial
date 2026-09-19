//! What the balance sheet is made of.
//!
//! The statement table already lists every line; this turns each of its three
//! sections into shares of that section's own total, so the panel can draw
//! them as rings. Nothing is clamped, scaled or invented to make a circle
//! close: a ring is produced only when the reported lines really are parts of
//! the whole they are drawn inside, and when they are not, the reason travels
//! in place of the slices.
use serde::{Deserialize, Serialize};

/// A component holding less than this share of its total is folded into the
/// remainder instead of drawn, and a remainder this small is dropped: a few
/// hundred pixels across, such a slice is thinner than its own border. It is
const MIN_SHARE: f64 = 0.005;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Slice {
    pub label: String,
    pub value: f64,
    /// Share of the ring's total, between 0 and 1.
    pub share: f64,
}

/// One section of the balance sheet, as parts of its own total. The slices sum
/// to the total, up to a dropped remainder of less than half a percent.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Ring {
    pub name: String,
    pub total: Option<f64>,
    pub slices: Vec<Slice>,
    /// Why this section has no slices, when it has none.
    pub note: Option<String>,
}

/// The three sections of one fiscal year's balance sheet.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Composition {
    pub year: i32,
    pub end: Option<String>,
    pub assets: Ring,
    pub liabilities: Ring,
    pub equity: Ring,
}

fn finite(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}
fn sum(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    finite(a? + b?)
}
/// Rounded to the million the statement table itself displays, so a note never
/// quotes a figure the reader cannot find in the rows below it.
fn millions(value: f64) -> String {
    format!("{:.1}M", value / 1e6)
}

/// One section: its total, the lines reported inside it, and the name for
/// whatever the reported lines leave over.
fn ring(name: &str, total: Option<f64>, parts: &[(&str, Option<f64>)], other: &str) -> Ring {
    let mut ring = Ring {
        name: name.to_owned(),
        total: total.and_then(finite),
        ..Ring::default()
    };
    let Some(total) = ring.total else {
        ring.note = Some(format!(
            "{name} was not reported for this year, so the lines inside it are not shares of anything."
        ));
        return ring;
    };
    if total <= 0.0 {
        ring.note = Some(format!(
            "{name} was reported as {}, which is not a positive total whose lines can be drawn as shares.",
            millions(total),
        ));
        return ring;
    }
    let reported: Vec<(&str, f64)> = parts
        .iter()
        .filter_map(|(label, value)| Some((*label, finite((*value)?)?)))
        .collect();
    if reported.is_empty() {
        ring.note = Some(format!(
            "No lines inside {} were reported, so there is nothing to break the {} of {} into.",
            name.to_lowercase(),
            millions(total),
            name.to_lowercase(),
        ));
        return ring;
    }
    // A negative line is a real balance-sheet value — an accumulated deficit,
    // treasury stock — but it is not a part of a whole, and a ring that
    // silently dropped it would show the rest as larger shares than they are.
    if let Some((label, value)) = reported.iter().find(|(_, value)| *value < 0.0) {
        ring.note = Some(format!(
            "{label} is negative ({}), which cannot be drawn as a share of {}. The rows below carry the figures.",
            millions(*value),
            name.to_lowercase(),
        ));
        return ring;
    }
    let reported_total: f64 = reported.iter().map(|(_, value)| value).sum();
    if reported_total > total {
        ring.note = Some(format!(
            "The reported lines add up to {}, more than the {} of {} they are inside, so they are not shares of it.",
            millions(reported_total),
            millions(total),
            name.to_lowercase(),
        ));
        return ring;
    }
    // Everything the reported lines do not account for is one remaining slice,
    // and the slivers too thin to draw join it rather than disappearing.
    let mut slices: Vec<Slice> = reported
        .iter()
        .filter(|(_, value)| value / total >= MIN_SHARE)
        .map(|(label, value)| Slice {
            label: (*label).to_owned(),
            value: *value,
            share: value / total,
        })
        .collect();
    let drawn: f64 = slices.iter().map(|s| s.value).sum();
    let remainder = (total.max(reported_total) - drawn).max(0.0);
    if remainder / total >= MIN_SHARE {
        slices.push(Slice {
            label: other.to_owned(),
            value: remainder,
            share: remainder / total,
        });
    }
    ring.slices = slices;
    ring
}

/// The three rings for one fiscal year. `value` reads a metric by the same key
/// the statement rows use, so the chart and the table can never disagree.
pub fn compose(year: i32, end: Option<String>, value: &dyn Fn(&str) -> Option<f64>) -> Composition {
    let current_assets = value("annualCurrentAssets");
    let current_liabilities = value("annualCurrentLiabilities");
    Composition {
        year,
        end,
        assets: ring(
            "Total assets",
            value("annualTotalAssets")
                .or_else(|| sum(current_assets, value("annualTotalNonCurrentAssets"))),
            &[
                ("Cash & equivalents", value("annualCashAndCashEquivalents")),
                ("Accounts receivable", value("annualAccountsReceivable")),
                ("Inventory", value("annualInventory")),
                ("Net PP&E", value("annualNetPPE")),
            ],
            "Other assets",
        ),
        liabilities: ring(
            "Total liabilities",
            value("annualTotalLiabilitiesNetMinorityInterest").or_else(|| {
                sum(
                    current_liabilities,
                    value("annualTotalNonCurrentLiabilitiesNetMinorityInterest"),
                )
            }),
            // Total debt is current debt plus long-term debt, so including it
            // would count the same borrowing twice.
            &[
                ("Accounts payable", value("annualAccountsPayable")),
                ("Current debt", value("annualCurrentDebt")),
                ("Long-term debt", value("annualLongTermDebt")),
            ],
            "Other liabilities",
        ),
        equity: ring(
            "Stockholders equity",
            value("annualStockholdersEquity"),
            &[("Retained earnings", value("annualRetainedEarnings"))],
            "Paid-in capital & reserves",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn reader<'a>(values: &'a BTreeMap<&'static str, f64>) -> impl Fn(&str) -> Option<f64> + 'a {
        move |key: &str| values.get(key).copied()
    }
    fn sheet() -> BTreeMap<&'static str, f64> {
        BTreeMap::from([
            ("annualCashAndCashEquivalents", 200e6),
            ("annualAccountsReceivable", 150e6),
            ("annualInventory", 100e6),
            ("annualNetPPE", 750e6),
            ("annualTotalAssets", 1500e6),
            ("annualAccountsPayable", 125e6),
            ("annualCurrentDebt", 75e6),
            ("annualLongTermDebt", 200e6),
            ("annualTotalLiabilitiesNetMinorityInterest", 500e6),
            ("annualRetainedEarnings", 600e6),
            ("annualStockholdersEquity", 1000e6),
        ])
    }
    fn shares(ring: &Ring) -> Vec<(String, f64)> {
        ring.slices
            .iter()
            .map(|s| (s.label.clone(), (s.share * 1000.0).round() / 1000.0))
            .collect()
    }

    #[test]
    fn each_section_is_split_into_its_reported_lines_and_what_is_left() {
        let values = sheet();
        let composed = compose(2025, Some("2025-12-31".into()), &reader(&values));
        assert_eq!(composed.year, 2025);
        assert_eq!(composed.assets.total, Some(1500e6));
        assert_eq!(
            shares(&composed.assets),
            [
                ("Cash & equivalents".into(), 0.133),
                ("Accounts receivable".into(), 0.1),
                ("Inventory".into(), 0.067),
                ("Net PP&E".into(), 0.5),
                ("Other assets".into(), 0.2),
            ]
        );
        assert_eq!(
            shares(&composed.liabilities),
            [
                ("Accounts payable".into(), 0.25),
                ("Current debt".into(), 0.15),
                ("Long-term debt".into(), 0.4),
                ("Other liabilities".into(), 0.2),
            ]
        );
        assert_eq!(
            shares(&composed.equity),
            [
                ("Retained earnings".into(), 0.6),
                ("Paid-in capital & reserves".into(), 0.4),
            ]
        );
        // Every ring accounts for its whole total, and for nothing more.
        for ring in [&composed.assets, &composed.liabilities, &composed.equity] {
            let drawn: f64 = ring.slices.iter().map(|s| s.value).sum();
            assert!((drawn - ring.total.unwrap()).abs() < 1.0, "{}", ring.name);
            assert!(ring.note.is_none());
        }
    }

    #[test]
    fn subtotals_stand_in_for_a_missing_total_and_a_missing_line_widens_the_remainder() {
        let mut values = sheet();
        values.remove("annualTotalAssets");
        values.insert("annualCurrentAssets", 450e6);
        values.insert("annualTotalNonCurrentAssets", 1050e6);
        values.remove("annualTotalLiabilitiesNetMinorityInterest");
        values.remove("annualInventory");
        let composed = compose(2025, None, &reader(&values));
        // The two subtotals are the total, by definition of the statement.
        assert_eq!(composed.assets.total, Some(1500e6));
        // Inventory is gone, so its 100M is part of what is left over rather
        // than a slice of its own or a hole in the ring.
        assert_eq!(
            shares(&composed.assets),
            [
                ("Cash & equivalents".into(), 0.133),
                ("Accounts receivable".into(), 0.1),
                ("Net PP&E".into(), 0.5),
                ("Other assets".into(), 0.267),
            ]
        );
        // Neither liabilities subtotal was reported either, so there is no
        // whole to take shares of, and the rows below say so instead.
        assert_eq!(composed.liabilities.total, None);
        assert!(composed.liabilities.slices.is_empty());
        assert!(composed
            .liabilities
            .note
            .as_ref()
            .is_some_and(|note| note.contains("was not reported")));
    }

    #[test]
    fn a_negative_line_or_one_that_overruns_its_total_is_explained_rather_than_drawn() {
        let mut values = sheet();
        // An accumulated deficit is a real equity line and not a share of one.
        values.insert("annualRetainedEarnings", -250e6);
        let deficit = compose(2025, None, &reader(&values)).equity;
        assert!(deficit.slices.is_empty());
        assert_eq!(deficit.total, Some(1000e6));
        assert_eq!(
            deficit.note.as_deref(),
            Some("Retained earnings is negative (-250.0M), which cannot be drawn as a share of stockholders equity. The rows below carry the figures.")
        );

        // Buybacks can leave retained earnings above total equity; the parts
        // are then not parts, and the ring says so rather than rescaling them.
        values.insert("annualRetainedEarnings", 1200e6);
        let overrun = compose(2025, None, &reader(&values)).equity;
        assert!(overrun.slices.is_empty());
        assert!(overrun
            .note
            .as_ref()
            .is_some_and(|note| note.contains("more than the 1000.0M")));

        // A reported non-positive total is no denominator, but it is distinct
        // from an absent total and the explanation preserves that fact.
        values.insert("annualStockholdersEquity", -50e6);
        assert!(compose(2025, None, &reader(&values))
            .equity
            .note
            .is_some_and(|note| note.contains("was reported as -50.0M")));

        // Even a small overrun would make displayed shares exceed 100%, so it
        // is rejected rather than relying on the chart to normalize it.
        values.insert("annualStockholdersEquity", 1000e6);
        values.insert("annualRetainedEarnings", 1001e6);
        let rounding_overrun = compose(2025, None, &reader(&values)).equity;
        assert!(rounding_overrun.slices.is_empty());
        assert!(rounding_overrun
            .note
            .is_some_and(|note| note.contains("more than the 1000.0M")));
    }

    #[test]
    fn slivers_join_the_remainder_and_a_bare_total_reports_that_it_is_bare() {
        let mut values = sheet();
        // Two thousandths of the balance sheet is thinner than the line around
        // it, so it is counted in the remainder rather than drawn.
        values.insert("annualInventory", 3e6);
        let assets = compose(2025, None, &reader(&values)).assets;
        assert!(!assets.slices.iter().any(|s| s.label == "Inventory"));
        let other = assets
            .slices
            .iter()
            .find(|s| s.label == "Other assets")
            .expect("what the drawn lines leave over");
        assert_eq!(other.value, 1500e6 - 200e6 - 150e6 - 750e6);
        assert!((assets.slices.iter().map(|s| s.share).sum::<f64>() - 1.0).abs() < 1e-9);

        let bare = BTreeMap::from([("annualTotalAssets", 1500e6)]);
        let ring = compose(2025, None, &reader(&bare)).assets;
        assert_eq!(ring.total, Some(1500e6));
        assert!(ring.slices.is_empty());
        assert!(ring
            .note
            .is_some_and(|note| note.contains("No lines inside total assets were reported")));
    }
}
