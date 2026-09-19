import { Card } from "@/components/ui/card";
import { hasTrend, Sparkline } from "@/components/financial-chart";
import { number, percent } from "@/lib/format";
import type { Nullable, Point, PointKey } from "@/lib/types";

/**
 * One headline figure for the latest fiscal year, with the same metric's
 * history drawn behind it when more than one year carries a value.
 */
export function Metric({
  label,
  value,
  unit,
  detail,
  points,
  trendKey,
  highlight = false,
}: {
  label: string;
  value: Nullable;
  unit: string;
  detail: string;
  points: Point[];
  trendKey: PointKey;
  highlight?: boolean;
}) {
  return (
    <Card className={`metric-card ${highlight ? "metric-highlight" : ""}`}>
      <div className="metric-label">{label}</div>
      <div
        className={`metric-value ${value !== null && value < 0 ? "negative" : ""}`}
      >
        {unit === "%" ? percent(value) : number(value)}
        {unit !== "%" && value !== null && <span>{unit}</span>}
      </div>
      <div className="metric-detail">{detail}</div>
      {hasTrend(points, trendKey) && (
        <div className="metric-trend" aria-hidden="true">
          <Sparkline
            points={points}
            dataKey={trendKey}
            tone={highlight ? "accent" : "muted"}
          />
        </div>
      )}
    </Card>
  );
}
