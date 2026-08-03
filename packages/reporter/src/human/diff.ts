import type { DiffReport } from "@crimes/core";
import type { FeedbackHintOptions } from "./shared.js";
import { HUMAN_GLYPHS, pc, plainColour } from "./shared.js";

export interface DiffHumanReportOptions {
  /** Disable ANSI colour output. */
  noColor?: boolean;
  /** Inline feedback hints (0.7.0). Suppressed when `noColor` is true. */
  feedbackHints?: FeedbackHintOptions;
}

export function formatDiffReport(
  report: DiffReport,
  options: DiffHumanReportOptions = {},
): string {
  const noColor = options.noColor === true;
  const colour = noColor ? plainColour() : pc;
  const lines: string[] = [];

  lines.push(colour.bold("CRIMES DIFF"));
  lines.push(`base: ${colour.cyan(report.base)}`);
  lines.push(`head: ${colour.cyan(report.head)}`);
  lines.push("");

  const newCount = colour.red(`${report.summary.new}`);
  const fixedCount = colour.green(`${report.summary.fixed}`);
  const unchangedCount = colour.dim(`${report.summary.unchanged}`);

  const newPrefix = noColor ? "" : `${HUMAN_GLYPHS.new} `;
  const fixedPrefix = noColor ? "" : `${HUMAN_GLYPHS.fixed} `;
  const unchangedPrefix = noColor ? "" : `${HUMAN_GLYPHS.unchanged} `;

  lines.push(`${newPrefix}New crimes: ${newCount}`);
  lines.push(`${fixedPrefix}Fixed crimes: ${fixedCount}`);
  lines.push(`${unchangedPrefix}Unchanged crimes: ${unchangedCount}`);

  // Three integers and nothing to act on. A reviewer told "New crimes:
  // 7" has to re-run the command in `--format json` to find out where,
  // which makes the human output a strictly worse way to read the same
  // report. List them.
  renderChangeList(lines, "New", report.new_findings, colour.red, colour);
  renderChangeList(lines, "Fixed", report.fixed_findings, colour.green, colour);

  return lines.join("\n");
}

/** Findings listed per section before the rest are counted off. */
const DIFF_LIST_CAP = 10;

function renderChangeList(
  lines: string[],
  label: string,
  findings: DiffReport["new_findings"],
  accent: (s: string) => string,
  colour: ReturnType<typeof plainColour>,
): void {
  if (findings.length === 0) return;
  lines.push("");
  lines.push(accent(`${label} (${findings.length})`));
  for (const finding of findings.slice(0, DIFF_LIST_CAP)) {
    const where =
      finding.lines !== undefined ? `${finding.file}:${finding.lines[0]}` : finding.file;
    const symbol = finding.symbol ? ` ${colour.dim(`· ${finding.symbol}`)}` : "";
    lines.push(`  ${finding.severity.padEnd(6)} ${where}${symbol}  ${finding.charge}`);
  }
  if (findings.length > DIFF_LIST_CAP) {
    lines.push(colour.dim(`  …+${findings.length - DIFF_LIST_CAP} more`));
  }
}
