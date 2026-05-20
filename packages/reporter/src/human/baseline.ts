import type {
  Baseline,
  BaselineCheckReport,
  BaselineEntry,
} from "@crimes/core";
import type { ColourFns, FeedbackHintOptions } from "./shared.js";
import { HUMAN_GLYPHS, pc, plainColour, renderFinding } from "./shared.js";

export interface BaselineHumanReportOptions {
  /** Disable ANSI colour output. */
  noColor?: boolean;
  /** Inline feedback hints (0.7.0). Suppressed when `noColor` is true. */
  feedbackHints?: FeedbackHintOptions;
}

export function formatBaselineSaveReport(
  baseline: Baseline,
  baselinePath: string,
  options: BaselineHumanReportOptions = {},
): string {
  const colour = options.noColor ? plainColour() : pc;
  const lines: string[] = [];

  lines.push(colour.bold("CRIMES BASELINE SAVED"));
  lines.push(colour.dim(`path: ${baselinePath}`));
  lines.push(colour.dim(`created_at: ${baseline.created_at}`));
  lines.push("");

  const { total, high, medium, low } = baseline.summary;
  lines.push(
    `Recorded ${colour.bold(String(total))} finding${
      total === 1 ? "" : "s"
    } as the new baseline.`,
  );
  lines.push(
    colour.dim(
      `  ${colour.red(`high ${high}`)}  ${colour.yellow(`medium ${medium}`)}  ${colour.dim(`low ${low}`)}`,
    ),
  );
  lines.push("");
  lines.push(
    colour.dim(
      "Commit `.crimes/baseline.json` so future `crimes baseline check` runs share the same starting line.",
    ),
  );

  return lines.join("\n");
}

export function formatBaselineCheckReport(
  report: BaselineCheckReport,
  options: BaselineHumanReportOptions = {},
): string {
  const noColor = options.noColor === true;
  const colour = noColor ? plainColour() : pc;
  const lines: string[] = [];

  lines.push(colour.bold("CRIMES BASELINE CHECK"));
  lines.push(colour.dim(`baseline: ${report.baseline_path}`));
  lines.push(colour.dim(`fail-on: ${report.fail_on}`));
  lines.push("");

  const { summary } = report;
  const newCount = colour.red(`${summary.new}`);
  const fixedCount = colour.green(`${summary.fixed}`);
  const unchangedCount = colour.dim(`${summary.unchanged}`);

  const newPrefix = noColor ? "" : `${HUMAN_GLYPHS.new} `;
  const fixedPrefix = noColor ? "" : `${HUMAN_GLYPHS.fixed} `;
  const unchangedPrefix = noColor ? "" : `${HUMAN_GLYPHS.unchanged} `;

  lines.push(`${newPrefix}New crimes: ${newCount}`);
  lines.push(
    colour.dim(
      `  ${colour.red(`high ${summary.new_by_severity.high}`)}  ${colour.yellow(
        `medium ${summary.new_by_severity.medium}`,
      )}  ${colour.dim(`low ${summary.new_by_severity.low}`)}`,
    ),
  );
  lines.push(`${fixedPrefix}Fixed crimes: ${fixedCount}`);
  lines.push(`${unchangedPrefix}Unchanged crimes: ${unchangedCount}`);
  lines.push("");

  if (report.new_findings.length > 0) {
    lines.push(
      colour.bold(`${newPrefix}New findings (${report.new_findings.length})`),
    );
    report.new_findings.forEach((finding, idx) => {
      // Baseline check has no --all knob; fall back to the default notable
      // gate (renderRiskProfileLine hides the line when all three signals
      // are ≤ 0.5).
      lines.push(
        ...renderFinding(finding, idx + 1, colour, {
          feedbackHints: options.feedbackHints,
          noColor: options.noColor === true,
        }),
      );
      lines.push("");
    });
    if (lines[lines.length - 1] === "") lines.pop();
    lines.push("");
  }

  if (report.fixed_findings.length > 0) {
    lines.push(
      colour.bold(`${fixedPrefix}Fixed findings (${report.fixed_findings.length})`),
    );
    report.fixed_findings.forEach((entry, idx) => {
      lines.push(...renderBaselineEntry(entry, idx + 1, colour));
    });
    lines.push("");
  }

  if (report.failed) {
    lines.push(
      colour.red(
        colour.bold(
          `FAILED: ${report.new_findings.length} new finding${
            report.new_findings.length === 1 ? "" : "s"
          } at or above "${report.fail_on}" severity.`,
        ),
      ),
    );
  } else {
    lines.push(
      colour.green(
        colour.bold(
          `OK: no new findings at or above "${report.fail_on}" severity.`,
        ),
      ),
    );
  }

  return lines.join("\n");
}

function renderBaselineEntry(
  entry: BaselineEntry,
  n: number,
  colour: ColourFns,
): string[] {
  const symbol = entry.symbol ? ` (${entry.symbol})` : "";
  const out: string[] = [];
  out.push(
    `  ${colour.bold(`${n}.`)} ${colour.cyan(entry.file)}${colour.dim(symbol)}`,
  );
  out.push(
    `     ${colour.bold("Charge:")} ${entry.charge} (${entry.severity})`,
  );
  return out;
}
