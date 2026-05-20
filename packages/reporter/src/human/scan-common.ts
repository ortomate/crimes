import type { ScanReport } from "@crimes/core";
import type { ColourFns } from "./shared.js";

export function summaryLine(report: ScanReport, colour: ColourFns): string {
  const { high, medium, low, total } = report.summary;
  return colour.dim(
    `Total ${total}  ·  ${colour.red(`high ${high}`)}  ${colour.yellow(`medium ${medium}`)}  ${colour.dim(`low ${low}`)}`,
  );
}

export function severityCountsLine(
  report: ScanReport,
  colour: ColourFns,
): string {
  const { high, medium, low } = report.summary;
  return `${colour.red(`${high} high`)}  ${colour.yellow(`${medium} medium`)}  ${colour.dim(`${low} low`)}`;
}

export function suppressedCountLine(report: ScanReport): string | undefined {
  if (!report.suppressed_count || report.suppressed_count <= 0) {
    return undefined;
  }
  return `${report.suppressed_count} finding${
    report.suppressed_count === 1 ? "" : "s"
  } suppressed; run with --show-suppressed to see.`;
}
