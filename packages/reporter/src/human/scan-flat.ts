import type { Finding, ScanReport, Severity } from "@crimes/core";
import {
  pushSummaryRepeat,
  scanSummaryLine,
  suppressedCountLine,
} from "./scan-common.js";
import type { ColourFns } from "./shared.js";
import { pc, plainColour, renderFinding, severityGlyph } from "./shared.js";
import type { HumanReportOptions } from "./scan.js";

const DEFAULT_TOP_N = 10;

/**
 * Legacy severity-grouped layout. Preserved so `--flat` users
 * (greppers, downstream parsers that snapshot the old format) can keep
 * running without changes.
 */
export function formatHumanReportFlat(
  report: ScanReport,
  options: HumanReportOptions = {},
): string {
  const colour = options.noColor ? plainColour() : pc;
  const topN = options.topN ?? DEFAULT_TOP_N;
  const isShowingAll = options.showAll ?? false;

  const lines = renderFlatHeader(report, colour);
  if (report.findings.length === 0) {
    const cleanPrefix = options.noColor ? "" : "✨ ";
    lines.push(colour.green(`${cleanPrefix}No crimes detected. Suspiciously clean.`));
    return lines.join("\n");
  }

  const shown = isShowingAll ? report.findings : report.findings.slice(0, topN);
  renderSeverityGroups(lines, shown, colour, {
    isShowingAll,
    isColorDisabled: options.noColor === true,
    feedbackHints: options.feedbackHints,
  });
  renderFlatFooter(lines, report, shown.length, isShowingAll, colour);
  return lines.join("\n");
}

function renderFlatHeader(report: ScanReport, colour: ColourFns): string[] {
  return [colour.bold("CRIME SCENE REPORT"), scanSummaryLine(report, colour), ""];
}

function renderSeverityGroups(
  lines: string[],
  shown: Finding[],
  colour: ColourFns,
  options: Pick<HumanReportOptions, "feedbackHints"> & {
    isShowingAll: boolean;
    isColorDisabled: boolean;
  },
): void {
  const grouped = groupBySeverity(shown);
  for (const sev of ["high", "medium", "low"] as const) {
    const group = grouped[sev];
    if (group.length === 0) continue;
    lines.push(severityHeading(sev, group.length, colour, options.isColorDisabled));
    group.forEach((finding, idx) => {
      lines.push(
        ...renderFinding(finding, idx + 1, colour, {
          alwaysShowRiskProfile: options.isShowingAll,
          feedbackHints: options.feedbackHints,
          noColor: options.isColorDisabled,
        }),
      );
      lines.push("");
    });
  }
}

function renderFlatFooter(
  lines: string[],
  report: ScanReport,
  shownCount: number,
  isShowingAll: boolean,
  colour: ColourFns,
): void {
  if (!isShowingAll && report.findings.length > shownCount) {
    const hidden = report.findings.length - shownCount;
    lines.push(
      colour.dim(
        `Showing top ${shownCount} of ${report.findings.length}. Run with --all to see ${hidden} more.`,
      ),
    );
  }
  pushSummaryRepeat(lines, report, colour);
  const suppressedLine = suppressedCountLine(report);
  if (suppressedLine) lines.push(colour.dim(suppressedLine));
}

function severityHeading(
  sev: Severity,
  count: number,
  colour: ColourFns,
  isColorDisabled: boolean,
): string {
  const label = `${severityGlyph(sev, isColorDisabled)}${sev.toUpperCase()} severity (${count})`;
  switch (sev) {
    case "high":
      return colour.red(colour.bold(label));
    case "medium":
      return colour.yellow(colour.bold(label));
    case "low":
      return colour.dim(colour.bold(label));
  }
}

function groupBySeverity(findings: Finding[]): Record<Severity, Finding[]> {
  const groups: Record<Severity, Finding[]> = { high: [], medium: [], low: [] };
  for (const f of findings) groups[f.severity].push(f);
  return groups;
}
