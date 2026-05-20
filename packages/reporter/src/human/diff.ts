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

  return lines.join("\n");
}
