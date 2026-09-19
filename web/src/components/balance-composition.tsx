import { useState } from "react";
import { Label, Pie, PieChart } from "recharts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { number, percent } from "@/lib/format";
import type { CompositionRing, Report } from "@/lib/types";

const colors = [1, 2, 3, 4, 5].map((index) => `var(--chart-${index})`);
const millions = (value: number) => number(value / 1e6, 1);
const compact = (value: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

/**
 * One section of the balance sheet as a donut: the reported lines inside it,
 * plus whatever they leave over, each as a share of the section's own total.
 * The engine decides what is drawable — a negative line or a set of lines that
 * overruns its total is not a share of anything — so this shows the reason it
 * gives rather than a circle that does not mean what it looks like.
 */
function Ring({ ring, currency }: { ring: CompositionRing; currency: string }) {
  const config: ChartConfig = Object.fromEntries(
    ring.slices.map((slice, i) => [
      slice.label,
      { label: slice.label, color: colors[i % colors.length] },
    ]),
  );
  const data = ring.slices.map((slice, i) => ({
    ...slice,
    fill: colors[i % colors.length],
  }));
  const summary = ring.slices
    .map((slice) => `${slice.label} ${percent(slice.share)}`)
    .join(", ");
  return (
    <Card className="chart-card composition-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>{ring.name}</CardTitle>
            <CardDescription className="mt-1.5">
              {ring.total === null
                ? "Not reported"
                : `${millions(ring.total)} · ${currency} millions`}
            </CardDescription>
          </div>
          <span className="chart-unit">% of total</span>
        </div>
      </CardHeader>
      <CardContent>
        {ring.slices.length ? (
          <ChartContainer
            config={config}
            className="mx-auto aspect-square h-[215px]"
            role="img"
            aria-label={`${ring.name}: ${summary}`}
          >
            <PieChart>
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    hideLabel
                    nameKey="label"
                    formatter={(value, name) => (
                      <div className="flex min-w-44 justify-between gap-5">
                        <span className="text-muted-foreground">
                          {String(name)}
                        </span>
                        <span className="font-mono font-medium text-foreground">
                          {millions(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Pie
                data={data}
                dataKey="value"
                nameKey="label"
                innerRadius={62}
                outerRadius={94}
                paddingAngle={1.5}
                stroke="var(--card)"
                strokeWidth={2}
                isAnimationActive={false}
              >
                <Label
                  content={({ viewBox }) =>
                    viewBox && "cx" in viewBox ? (
                      <text
                        x={viewBox.cx}
                        y={viewBox.cy}
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        <tspan
                          x={viewBox.cx}
                          y={viewBox.cy}
                          className="composition-total"
                        >
                          {compact(ring.total ?? 0)}
                        </tspan>
                        <tspan
                          x={viewBox.cx}
                          y={(viewBox.cy ?? 0) + 19}
                          className="composition-total-caption"
                        >
                          {currency}
                        </tspan>
                      </text>
                    ) : null
                  }
                />
              </Pie>
            </PieChart>
          </ChartContainer>
        ) : (
          <div className="chart-empty">
            <span>Not shown as shares</span>
            <p>{ring.note}</p>
          </div>
        )}
        <dl className="composition-legend">
          {ring.slices.map((slice, i) => (
            <div key={slice.label}>
              <dt>
                <i style={{ background: colors[i % colors.length] }} />
                {slice.label}
              </dt>
              <dd className="font-mono tabular-nums">
                {millions(slice.value)}
                <span>{percent(slice.share)}</span>
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * The balance sheet as three rings, for one fiscal year at a time. The table
 * below carries every line and every year; this is the shape of one of them.
 */
export function BalanceComposition({ report }: { report: Report }) {
  const [chosen, setChosen] = useState<number | null>(null);
  const composition = report.composition ?? [];
  const shown =
    composition.find((year) => year.year === chosen) ?? composition.at(-1);
  if (!shown) {
    return null;
  }
  const currency = report.currency || "Reporting currency";
  return (
    <section
      className="composition-panel"
      aria-label="Balance sheet composition"
    >
      <div className="statement-heading">
        <div>
          <h2>Composition</h2>
          <p>
            Each section as shares of its own total, from the same lines the
            table below reports. What those lines do not account for is drawn as
            one remaining slice rather than left out of the circle.
          </p>
        </div>
        <div className="composition-controls">
          <label htmlFor="composition-year">Fiscal year</label>
          <select
            id="composition-year"
            value={shown.year}
            onChange={(e) => setChosen(Number(e.target.value))}
          >
            {composition.map((year) => (
              <option key={year.year} value={year.year}>
                FY {year.year}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="composition-grid">
        {[shown.assets, shown.liabilities, shown.equity].map((ring) => (
          <Ring key={ring.name} ring={ring} currency={currency} />
        ))}
      </div>
      <p className="footnote mt-4">
        Fiscal year ending {shown.end || "unavailable"}. Amounts in {currency}{" "}
        millions.
      </p>
    </section>
  );
}
