import type { Finding, ScanReport } from "@crimes/core";
import { formatHumanReportFlat } from "./scan-flat.js";
import {
  groupByFile,
  nonDomainCountsLine,
  renderFileGroups,
  renderResurfaceBlock,
} from "./scan-groups.js";
import {
  severityCountsLine,
  summaryLine,
  suppressedCountLine,
} from "./scan-common.js";
import type { ColourFns, FeedbackHintOptions } from "./shared.js";
import { pc, plainColour, renderFinding } from "./shared.js";

export interface HumanReportOptions {
  showAll?: boolean;
  topN?: number;
  topFiles?: number;
  noColor?: boolean;
  flat?: boolean;
  feedbackHints?: FeedbackHintOptions;
}

const DEFAULT_TOP_FILES = 5;

export function formatHumanReport(
  report: ScanReport,
  options: HumanReportOptions = {},
): string {
  if (options.flat) return formatHumanReportFlat(report, options);

  const colour = options.noColor ? plainColour() : pc;
  const context = {
    colour,
    isColorDisabled: options.noColor === true,
    topFiles: options.topFiles ?? DEFAULT_TOP_FILES,
    feedbackHints: options.feedbackHints,
  };
  const lines = renderHeader(report, context);
  if (report.findings.length === 0) return lines.join("\n");

  const partition = partitionFindingsForScan(report.findings);
  if (partition.resurfaced.length > 0) {
    renderResurfacedSection(lines, partition.resurfaced, context);
  }

  if (options.showAll === true) {
    renderAllFindings(lines, report, context);
  } else {
    renderGroupedFindings(lines, partition, context);
  }

  const suppressedLine = suppressedCountLine(report);
  if (suppressedLine) {
    lines.push("");
    lines.push(colour.dim(suppressedLine));
  }
  return lines.join("\n");
}

interface RenderContext {
  colour: ColourFns;
  isColorDisabled: boolean;
  topFiles: number;
  feedbackHints?: FeedbackHintOptions;
}

interface FindingPartition {
  resurfaced: Finding[];
  domain: Finding[];
  nonDomain: Finding[];
}

function renderHeader(report: ScanReport, context: RenderContext): string[] {
  const { colour, isColorDisabled } = context;
  const lines = [colour.bold("CRIME SCENE REPORT")];
  if (report.findings.length === 0) {
    lines.push(colour.dim(`repo: ${report.repo.name}  ·  0 findings`));
    lines.push("");
    const cleanPrefix = isColorDisabled ? "" : "✨ ";
    lines.push(colour.green(`${cleanPrefix}No crimes detected. Suspiciously clean.`));
    return lines;
  }
  const fileCount = new Set(report.findings.map((f) => f.file)).size;
  lines.push(
    colour.dim(
      `repo: ${report.repo.name}  ·  ${report.findings.length} finding${
        report.findings.length === 1 ? "" : "s"
      } across ${fileCount} file${fileCount === 1 ? "" : "s"}  ·  ${severityCountsLine(report, colour)}`,
    ),
  );
  return lines;
}

function partitionFindingsForScan(findings: Finding[]): FindingPartition {
  const isResurfaced = (f: Finding): boolean =>
    f.previously_triaged === true || f.previously_baselined === true;
  const resurfaced = findings.filter(isResurfaced);
  const fresh = findings.filter((f) => !isResurfaced(f));
  return {
    resurfaced,
    domain: fresh.filter((f) => f.tier !== "nonDomain"),
    nonDomain: fresh.filter((f) => f.tier === "nonDomain"),
  };
}

function renderResurfacedSection(
  lines: string[],
  resurfaced: Finding[],
  context: RenderContext,
): void {
  lines.push("");
  lines.push(
    context.colour.bold(
      "You're editing files you previously triaged — was this still intentional?",
    ),
  );
  renderResurfaceBlock(
    lines,
    resurfaced,
    context.colour,
    context.isColorDisabled,
  );
}

function renderAllFindings(
  lines: string[],
  report: ScanReport,
  context: RenderContext,
): void {
  lines.push("");
  report.findings.forEach((finding, idx) => {
    lines.push(
      ...renderFinding(finding, idx + 1, context.colour, {
        alwaysShowRiskProfile: true,
        feedbackHints: context.feedbackHints,
        noColor: context.isColorDisabled,
      }),
    );
    lines.push("");
  });
  lines.push(summaryLine(report, context.colour));
}

function renderGroupedFindings(
  lines: string[],
  partition: FindingPartition,
  context: RenderContext,
): void {
  if (partition.domain.length === 0 && partition.nonDomain.length === 0) {
    renderOnlyResurfacedClose(lines, partition.resurfaced);
  } else if (partition.domain.length === 0) {
    renderAllNonDomain(lines, partition.nonDomain, context);
  } else {
    renderDomainGroups(lines, partition.domain, partition.nonDomain, context);
  }
}

function renderOnlyResurfacedClose(lines: string[], resurfaced: Finding[]): void {
  if (resurfaced.length === 0) return;
  lines.push("");
  lines.push(
    `→ Start with \`crimes context ${resurfaced[0]!.file}\` — every fresh finding is silenced; only previously-triaged or baselined findings remain.`,
  );
}

function renderAllNonDomain(
  lines: string[],
  findings: Finding[],
  context: RenderContext,
): void {
  const grouped = groupByFile(findings);
  const shown = grouped.slice(0, context.topFiles);
  lines.push("");
  lines.push(context.colour.bold("All findings are in non-domain folders"));
  renderFileGroups(lines, shown, context.colour, context.isColorDisabled);
  if (grouped.length > shown.length) renderHiddenFileCount(lines, grouped.length, shown.length, context);
  lines.push("");
  lines.push(
    `→ Start with \`crimes context ${shown[0]!.file}\` — every finding is in non-domain folders; review your scopeTiers config if that surprises you.`,
  );
}

function renderDomainGroups(
  lines: string[],
  domain: Finding[],
  nonDomain: Finding[],
  context: RenderContext,
): void {
  const grouped = groupByFile(domain);
  const shown = grouped.slice(0, context.topFiles);
  lines.push("");
  lines.push(context.colour.bold("Top files by risk"));
  renderFileGroups(lines, shown, context.colour, context.isColorDisabled);
  if (grouped.length > shown.length) renderHiddenFileCount(lines, grouped.length, shown.length, context);
  if (nonDomain.length > 0) renderNonDomainFooter(lines, nonDomain, context);
  lines.push("");
  lines.push(
    `→ Start with \`crimes context ${shown[0]!.file}\` — it concentrates the most risk in this scan.`,
  );
}

function renderHiddenFileCount(
  lines: string[],
  total: number,
  shown: number,
  context: RenderContext,
): void {
  lines.push("");
  lines.push(
    context.colour.dim(
      `Showing ${shown} of ${total} files. Run with --all for every finding.`,
    ),
  );
}

function renderNonDomainFooter(
  lines: string[],
  nonDomain: Finding[],
  context: RenderContext,
): void {
  lines.push("");
  lines.push(context.colour.bold("Also flagged elsewhere"));
  lines.push(context.colour.dim(`  ${nonDomainCountsLine(nonDomain)}`));
  lines.push(context.colour.dim("  Run with --all to see them."));
}

export interface ScanFailOnLineOptions {
  noColor?: boolean;
}

export function formatScanFailOnLine(
  report: ScanReport,
  options: ScanFailOnLineOptions = {},
): string {
  const colour = options.noColor ? plainColour() : pc;
  const failOn = report.fail_on ?? "medium";
  const glyph = options.noColor ? "" : report.failed ? "❌ " : "✅ ";
  if (report.failed) {
    return colour.red(
      colour.bold(
        `${glyph}FAILED: at least one finding at or above "${failOn}" severity in the changed set.`,
      ),
    );
  }
  return colour.green(
    colour.bold(
      `${glyph}OK: no findings at or above "${failOn}" severity in the changed set.`,
    ),
  );
}
