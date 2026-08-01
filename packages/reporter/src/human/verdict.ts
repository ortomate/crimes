import type { Verdict, VerdictReport } from "@crimes/core";
import type { ColourFns } from "./shared.js";
import { HUMAN_GLYPHS, pc, plainColour } from "./shared.js";

export interface VerdictHumanReportOptions {
  /** Disable ANSI colour output. */
  noColor?: boolean;
}

export function formatVerdictReport(
  report: VerdictReport,
  options: VerdictHumanReportOptions = {},
): string {
  const noColor = options.noColor === true;
  const colour = noColor ? plainColour() : pc;
  const lines: string[] = [];

  lines.push(colour.bold("CRIMES VERDICT"));
  lines.push(`base: ${colour.cyan(report.base)}`);
  lines.push(`head: ${colour.cyan(report.head)}`);
  lines.push("");

  lines.push(`Verdict: ${verdictLabel(report.verdict, colour, noColor)}`);
  const newPrefix = noColor ? "" : `${HUMAN_GLYPHS.new} `;
  const fixedPrefix = noColor ? "" : `${HUMAN_GLYPHS.fixed} `;
  lines.push(`${newPrefix}New: ${colour.red(`${report.summary.new}`)}`);
  lines.push(`${fixedPrefix}Fixed: ${colour.green(`${report.summary.fixed}`)}`);

  if (report.reasons.length > 0) {
    lines.push(`Reason: ${report.reasons.join("; ")}`);
  }

  if (report.recommended_actions.length > 0) {
    lines.push(`Recommended next action: ${report.recommended_actions.join(" ")}`);
  }

  return lines.join("\n");
}

function verdictLabel(v: Verdict, colour: ColourFns, noColor: boolean): string {
  const upper = v.toUpperCase();
  const glyph = noColor ? "" : `${verdictGlyph(v)} `;
  switch (v) {
    case "worse":
      return colour.red(colour.bold(`${glyph}${upper}`));
    case "cleaner":
      return colour.green(colour.bold(`${glyph}${upper}`));
    case "unchanged":
      return colour.dim(colour.bold(`${glyph}${upper}`));
    case "mixed":
      return colour.yellow(colour.bold(`${glyph}${upper}`));
  }
}

function verdictGlyph(v: Verdict): string {
  switch (v) {
    case "worse":
      return HUMAN_GLYPHS.worse;
    case "cleaner":
      return HUMAN_GLYPHS.cleaner;
    case "unchanged":
      return HUMAN_GLYPHS.unchanged;
    case "mixed":
      return HUMAN_GLYPHS.mixed;
  }
}
