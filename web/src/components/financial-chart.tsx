import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
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
import { number } from "@/lib/format";
import type { Point, PointKey } from "@/lib/types";
const colors = [1, 2, 3, 4, 5].map((index) => `var(--chart-${index})`);
export interface Series {
  key: PointKey;
  label: string;
  color?: string;
}
export function FinancialChart({
  title,
  description,
  points,
  series,
  type = "bar",
  unit = "millions",
  percent = false,
}: {
  title: string;
  description: string;
  points: Point[];
  series: Series[];
  type?: "bar" | "line";
  unit?: string;
  percent?: boolean;
}) {
  const config: ChartConfig = Object.fromEntries(
    series.map((s, i) => [
      s.key,
      { label: s.label, color: s.color || colors[i % colors.length] },
    ]),
  );
  const hasValues = points.some((point) =>
    series.some((s) => point[s.key] !== null),
  );
  const formatValue = (value: number) =>
    percent ? `${number(value * 100, 1)}%` : number(value, 1);
  const common = (
    <>
      <CartesianGrid
        vertical={false}
        strokeDasharray="3 5"
        stroke="var(--border)"
      />
      <XAxis
        dataKey="year"
        tickLine={false}
        axisLine={false}
        tickMargin={12}
        minTickGap={10}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        width={66}
        tickFormatter={(value) =>
          percent
            ? `${number(value * 100, 0)}%`
            : new Intl.NumberFormat("en-US", {
                notation: "compact",
                maximumFractionDigits: 1,
              }).format(value)
        }
      />
      <ReferenceLine
        y={0}
        stroke="var(--muted-foreground)"
        strokeOpacity={0.4}
      />
      <ChartTooltip
        cursor={
          type === "bar"
            ? { fill: "rgba(255,255,255,.035)" }
            : { stroke: "var(--border)" }
        }
        content={
          <ChartTooltipContent
            labelFormatter={(label) => `FY ${label}`}
            formatter={(value, name) => (
              <div className="flex min-w-40 justify-between gap-5">
                <span className="text-muted-foreground">
                  {config[String(name)]?.label || String(name)}
                </span>
                <span className="font-mono font-medium text-foreground">
                  {formatValue(Number(value))}
                </span>
              </div>
            )}
          />
        }
      />
    </>
  );
  return (
    <Card className="chart-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription className="mt-1.5">{description}</CardDescription>
          </div>
          <span className="chart-unit">{unit}</span>
        </div>
      </CardHeader>
      <CardContent>
        {hasValues ? (
          <ChartContainer
            config={config}
            className="h-[265px] w-full aspect-auto"
            role="img"
            aria-label={`${title}, fiscal years ${points[0].year} to ${points.at(-1)?.year}`}
          >
            {type === "bar" ? (
              <BarChart
                accessibilityLayer
                data={points}
                margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
                barGap={5}
              >
                {common}
                {series.map((s, i) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    fill={s.color || colors[i % colors.length]}
                    radius={[3, 3, 0, 0]}
                    maxBarSize={42}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            ) : (
              <LineChart
                accessibilityLayer
                data={points}
                margin={{ top: 8, right: 15, left: 0, bottom: 8 }}
              >
                {common}
                {series.map((s, i) => (
                  <Line
                    key={s.key}
                    type="linear"
                    dataKey={s.key}
                    stroke={s.color || colors[i % colors.length]}
                    strokeWidth={2.5}
                    dot={{ r: 3, strokeWidth: 2, fill: "var(--card)" }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            )}
          </ChartContainer>
        ) : (
          <div className="chart-empty">
            <span>No data available</span>
            <p>
              This metric wasn't included in the provider's annual statements.
            </p>
          </div>
        )}
        <div className="chart-legend">
          {series.map((s, i) => (
            <span key={s.key}>
              <i style={{ background: s.color || colors[i % colors.length] }} />
              {s.label}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
export type SparklineTone = "muted" | "accent";

export function hasTrend(points: Point[], dataKey: PointKey) {
  return points.some((p) => p[dataKey] !== null);
}

// A trend-at-a-glance for a single metric card. Purely decorative: the
// number and detail line already state the value, so this stays aria-hidden.
export function Sparkline({
  points,
  dataKey,
  tone = "muted",
}: {
  points: Point[];
  dataKey: PointKey;
  tone?: SparklineTone;
}) {
  if (!hasTrend(points, dataKey)) {
    return null;
  }

  const color = tone === "accent" ? "var(--chart-1)" : "var(--muted-foreground)";
  const gradientId = `sparkline-${dataKey}`;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="linear"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#${gradientId})`}
          connectNulls={false}
          isAnimationActive={false}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
export function RevenueStreams({
  points,
  names,
  currency,
}: {
  points: Point[];
  names: string[];
  currency: string;
}) {
  const config: ChartConfig = Object.fromEntries(
    names.map((name, i) => [
      `stream${i}`,
      { label: name, color: colors[i % colors.length] },
    ]),
  );
  const data = points.map((p) => ({
    year: p.year,
    ...Object.fromEntries(
      names.map((name, i) => [
        `stream${i}`,
        Object.keys(p.streams).length ? (p.streams[name] ?? 0) : null,
      ]),
    ),
  }));
  return (
    <Card className="chart-card">
      <CardHeader>
        <CardTitle>Revenue by stream</CardTitle>
        <CardDescription>
          Reported products and services · {currency} millions
        </CardDescription>
      </CardHeader>
      <CardContent>
        {names.length ? (
          <>
            <ChartContainer
              config={config}
              className="h-[265px] w-full aspect-auto"
              role="img"
              aria-label="Revenue by stream"
            >
              <BarChart
                accessibilityLayer
                data={data}
                margin={{ top: 8, left: 0, right: 8, bottom: 8 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 5" />
                <XAxis dataKey="year" tickLine={false} axisLine={false} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={66}
                  tickFormatter={(v) =>
                    new Intl.NumberFormat("en-US", {
                      notation: "compact",
                    }).format(v)
                  }
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                {names.map((_, i) => (
                  <Bar
                    key={i}
                    dataKey={`stream${i}`}
                    stackId="revenue"
                    fill={colors[i % colors.length]}
                    maxBarSize={60}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ChartContainer>
            <div className="chart-legend">
              {names.map((name, i) => (
                <span key={name}>
                  <i style={{ background: colors[i % colors.length] }} />
                  {name}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="chart-empty">
            <span>Revenue breakdown not provided</span>
            <p>
              Total revenue is available above. Segment allocations are shown
              only when the source provides a complete breakdown.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
