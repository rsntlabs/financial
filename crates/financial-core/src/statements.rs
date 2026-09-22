/// (label shown in statement tables, stable internal metric ID, is this a subtotal line)
pub type Metric = (&'static str, &'static str, bool);

/// Revenue down through Net Income and per-share earnings, in income-statement order.
pub const INCOME_STATEMENT: &[Metric] = &[
    ("Total Revenue", "annualTotalRevenue", false),
    ("Cost of Revenue", "annualCostOfRevenue", false),
    ("Gross Profit", "annualGrossProfit", true),
    ("Operating Income", "annualOperatingIncome", true),
    ("EBIT", "annualEBIT", false),
    ("EBITDA", "annualEBITDA", false),
    (
        "Depreciation & Amortization",
        "annualDepreciationAmortizationDepletion",
        false,
    ),
    ("Net Income", "annualNetIncome", true),
    ("Diluted EPS", "annualDilutedEPS", false),
    ("Basic EPS", "annualBasicEPS", false),
];

/// Everything outside the income statement is appended after Net Income.
pub const BALANCE_SHEET: &[Metric] = &[
    (
        "Cash & Cash Equivalents",
        "annualCashAndCashEquivalents",
        false,
    ),
    ("Accounts Receivable", "annualAccountsReceivable", false),
    ("Inventory", "annualInventory", false),
    ("Total Current Assets", "annualCurrentAssets", true),
    ("Net PP&E", "annualNetPPE", false),
    ("Gross PP&E", "annualGrossPPE", false),
    (
        "Total Non-Current Assets",
        "annualTotalNonCurrentAssets",
        true,
    ),
    ("Total Assets", "annualTotalAssets", true),
    ("Accounts Payable", "annualAccountsPayable", false),
    ("Current Debt", "annualCurrentDebt", false),
    (
        "Total Current Liabilities",
        "annualCurrentLiabilities",
        true,
    ),
    ("Long-Term Debt", "annualLongTermDebt", false),
    ("Total Debt", "annualTotalDebt", false),
    (
        "Total Non-Current Liabilities",
        "annualTotalNonCurrentLiabilitiesNetMinorityInterest",
        true,
    ),
    (
        "Total Liabilities",
        "annualTotalLiabilitiesNetMinorityInterest",
        true,
    ),
    ("Retained Earnings", "annualRetainedEarnings", false),
    ("Stockholders Equity", "annualStockholdersEquity", true),
    ("Working Capital", "annualWorkingCapital", true),
];

pub const CASH_FLOW: &[Metric] = &[
    ("Net Income", "annualNetIncome", false),
    (
        "Depreciation & Amortization",
        "annualDepreciationAmortizationDepletion",
        false,
    ),
    (
        "Change in Working Capital",
        "annualChangeInWorkingCapital",
        false,
    ),
    ("Operating Cash Flow", "annualOperatingCashFlow", true),
    ("Capital Expenditure", "annualCapitalExpenditure", false),
    ("Investing Cash Flow", "annualInvestingCashFlow", true),
    ("Issuance of Debt", "annualIssuanceOfDebt", false),
    ("Repayment of Debt", "annualRepaymentOfDebt", false),
    (
        "Repurchase of Capital Stock",
        "annualRepurchaseOfCapitalStock",
        false,
    ),
    ("Cash Dividends Paid", "annualCashDividendsPaid", false),
    ("Financing Cash Flow", "annualFinancingCashFlow", true),
    ("Change in Cash", "annualChangesInCash", false),
    (
        "Beginning Cash Position",
        "annualBeginningCashPosition",
        false,
    ),
    ("Ending Cash Position", "annualEndCashPosition", false),
    ("Free Cash Flow", "annualFreeCashFlow", true),
];

/// A statement section: its line items plus the denominator the common-size
/// view divides them by.
pub struct Statement {
    pub name: &'static str,
    pub metrics: &'static [Metric],
    /// Metric ID every line is expressed against on the common-size view.
    pub base: &'static str,
    /// How that denominator reads in the UI, lower case.
    pub basis: &'static str,
}

/// The statement sections, in the order they should appear. A common-size
/// balance sheet is stated against total assets, not revenue: revenue is a
/// flow over the year and the balance sheet is a stock at its end, so the
/// ratio between them says nothing about the composition of the balance sheet.
pub const SECTIONS: &[Statement] = &[
    Statement {
        name: "Income Statement",
        metrics: INCOME_STATEMENT,
        base: "annualTotalRevenue",
        basis: "revenue",
    },
    Statement {
        name: "Balance Sheet",
        metrics: BALANCE_SHEET,
        base: "annualTotalAssets",
        basis: "total assets",
    },
    Statement {
        name: "Cash Flow Statement",
        metrics: CASH_FLOW,
        base: "annualTotalRevenue",
        basis: "revenue",
    },
];
