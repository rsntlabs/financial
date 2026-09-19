import { FinancialChart } from "@/components/financial-chart";
import { Metric } from "@/components/metric-card";
import type { Report } from "@/lib/types";

/**
 * Capital expenditure and depreciation, kept together on their own: what the
 * company spends on long-lived assets, what those assets cost it as they are
 * written down, and how the two compare. The figures head the panel for the
 * latest year with revenue; the charts carry the same fiscal-year window as
 * the rest of the dashboard.
 */
export function CapitalIntensity({ report }: { report: Report }) {
  const currency = report.currency || "Reporting currency";
  const latest = report.points.filter((p) => p.revenue !== null).at(-1);
  if (!latest) {
    return null;
  }
  return (
    <section
      className="capital-panel"
      aria-label="Capital investment and depreciation"
    >
      <div className="statement-heading">
        <div>
          <h2>Capital investment &amp; depreciation</h2>
          <p>
            Cash spent on long-lived assets against the depreciation and
            amortization those assets carry. Spending above D&amp;A grows the
            asset base; spending below it lets the base run down.
          </p>
        </div>
        <span className="capital-year">Fiscal year {latest.year}</span>
      </div>
      <div
        className="metric-grid capital-metrics"
        style={{ "--metric-cols": 5 } as React.CSSProperties}
      >
        <Metric
          label="Capital expenditure"
          value={latest.capex}
          unit="M"
          detail="Cash investment, shown as an outflow"
          points={report.points}
          trendKey="capex"
          highlight
        />
        <Metric
          label="Depreciation & amortization"
          value={latest.da}
          unit="M"
          detail="Annual D&A expense"
          points={report.points}
          trendKey="da"
        />
        <Metric
          label="CAPEX / D&A"
          value={latest.capexDa}
          unit="×"
          detail="Reinvestment against the write-down"
          points={report.points}
          trendKey="capexDa"
        />
        <Metric
          label="D&A / revenue"
          value={latest.daRevenue}
          unit="%"
          detail="Depreciation intensity"
          points={report.points}
          trendKey="daRevenue"
        />
        <Metric
          label="D&A / gross PP&E"
          value={latest.daPpe}
          unit="%"
          detail="Write-down against the asset base"
          points={report.points}
          trendKey="daPpe"
        />
      </div>
      <div className="chart-grid">
        <FinancialChart
          title="Capital investment"
          description="Capital expenditure alongside depreciation"
          points={report.points}
          series={[
            { key: "capex", label: "CAPEX" },
            { key: "da", label: "D&A" },
          ]}
          unit={`${currency} M`}
        />
        <FinancialChart
          title="Reinvestment pace"
          description="Capital expenditure relative to depreciation"
          points={report.points}
          series={[
            {
              key: "capexDa",
              label: "CAPEX / D&A",
              color: "var(--chart-3)",
            },
          ]}
          type="line"
          unit="Multiple (×)"
        />
        <FinancialChart
          title="Depreciation intensity"
          description="D&A relative to revenue and gross fixed assets"
          points={report.points}
          series={[
            { key: "daRevenue", label: "D&A / revenue" },
            { key: "daPpe", label: "D&A / gross PP&E" },
          ]}
          type="line"
          percent
          unit="Ratio (%)"
        />
      </div>
      <p className="footnote mt-4">
        Cash CAPEX is shown as a positive outflow, so CAPEX / D&amp;A is a
        positive multiple. D&amp;A / gross PP&amp;E uses year-end gross assets,
        derived from net PP&amp;E and accumulated depreciation when a source
        reports those instead. Ratios with missing or nonpositive denominators
        stay unavailable.
      </p>
    </section>
  );
}
