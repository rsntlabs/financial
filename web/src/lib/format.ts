import type { Nullable, Report } from "./types";
export const number = (value: Nullable, digits = 1) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      }).format(value);
export const percent = (value: Nullable) =>
  value === null ? "—" : `${number(value * 100)}%`;
export function downloadStatements(report: Report) {
  const escape = (value: unknown) => {
    // Text cells must remain text when opened by a spreadsheet application.
    const text =
      typeof value === "string" && /^[=+\-@\t\r]/.test(value)
        ? `'${value}`
        : String(value ?? "");
    return `"${text.replaceAll('"', '""')}"`;
  };
  const lines: unknown[][] = [
    ["Company", report.name, report.ticker],
    ["Currency", report.currency || "Reporting currency"],
    ["Amounts", "Raw currency units; EPS in currency per share"],
    [],
    ["Section", "Metric", ...report.years],
  ];
  for (const section of report.statements)
    for (const row of section.rows)
      lines.push([section.name, row.label, ...row.values]);
  const csv =
    "\uFEFF" + lines.map((line) => line.map(escape).join(",")).join("\r\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8;" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${report.ticker}_financials.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
