import type { ContextReport, ContextRisk } from "@crimes/core";
import { formatChurn, formatTestGap } from "./score-format.js";
import type { ColourFns, FeedbackHintOptions } from "./shared.js";
import { pc, plainColour, renderFinding } from "./shared.js";

export interface ContextHumanReportOptions {
  /** Disable ANSI colour output. */
  noColor?: boolean;
  /** Inline feedback hints (0.7.0). Suppressed when `noColor` is true. */
  feedbackHints?: FeedbackHintOptions;
}

export function formatContextHumanReport(
  report: ContextReport,
  options: ContextHumanReportOptions = {},
): string {
  const colour = options.noColor ? plainColour() : pc;
  const lines: string[] = [];

  lines.push(colour.bold("CRIMES CONTEXT"));
  lines.push(colour.dim(`file: ${report.file}`));
  lines.push(
    `risk: ${riskLabel(report.risk, colour)}  ${riskCounts(report.risk, colour)}`,
  );

  // Agent guidance — the field agents read first. Comes before findings
  // so a human running the human report sees the actionable summary line
  // before the more verbose finding bodies.
  lines.push("");
  lines.push(colour.bold("Agent guidance"));
  if (report.agent_guidance.length === 0) {
    const reason = report.agent_guidance_reason ?? "no specific guidance for this file";
    lines.push(colour.dim(`  (${reason})`));
  } else {
    for (const g of report.agent_guidance) {
      lines.push(`  · ${g}`);
    }
  }

  // Related files — neighbourhood discovery. Cap at 5 in the human
  // report (same convention as Finding.related_files) and note overflow.
  lines.push("");
  lines.push(colour.bold("Related files"));
  if (report.related_files.length === 0) {
    const reason = report.related_files_reason ?? "no related files found by convention";
    lines.push(colour.dim(`  (${reason})`));
  } else {
    const RELATED_DISPLAY_CAP = 5;
    const shown = report.related_files.slice(0, RELATED_DISPLAY_CAP);
    const hidden = report.related_files.length - shown.length;
    for (const r of shown) {
      lines.push(`  · ${colour.cyan(r.file)}  ${colour.dim(`— ${r.reason}`)}`);
    }
    if (hidden > 0) {
      lines.push(colour.dim(`  … and ${hidden} more (see JSON output)`));
    }
  }

  // Likely tests
  lines.push("");
  lines.push(colour.bold("Likely tests"));
  if (report.likely_tests.length === 0) {
    const reason = report.likely_tests_reason ?? "no likely tests found by convention";
    lines.push(colour.dim(`  (${reason})`));
  } else {
    for (const t of report.likely_tests) {
      lines.push(`  · ${colour.cyan(t)}`);
    }
  }

  // Clues — context-only signals beyond the per-file findings list.
  if (
    report.clues &&
    (report.clues.churn || report.clues.suppressions || report.clues.test_gap)
  ) {
    lines.push("");
    lines.push(colour.bold("Clues"));
    if (report.clues.churn) {
      const { commits_90d, last_commit_at, unique_authors_90d } = report.clues.churn;
      const churnLabel = formatChurn(
        Math.min(commits_90d / 30, 1), // approximate score from the count
        commits_90d,
        last_commit_at,
      );
      lines.push(
        `  · churn: ${churnLabel} · ${unique_authors_90d} author${unique_authors_90d === 1 ? "" : "s"}`,
      );
    }
    if (report.clues.test_gap) {
      lines.push(
        `  · test gap: ${formatTestGap(report.clues.test_gap.raw, report.clues.test_gap.label)}`,
      );
    }
    if (report.clues.suppressions && report.clues.suppressions.length > 0) {
      const n = report.clues.suppressions.length;
      lines.push(`  · known suppressions: ${n} (review with crimes audit-suppressions)`);
    }
  }

  // Findings — last, more verbose. Agents acting on the JSON read this
  // section from the structured `findings` array; humans get the same
  // information rendered.
  lines.push("");
  if (report.findings.length === 0) {
    lines.push(colour.green("No findings on this file. Suspiciously clean."));
  } else {
    lines.push(colour.bold("Findings"));
    report.findings.forEach((finding, idx) => {
      // crimes context <file> is a deep-dive on a single file — always
      // surface the risk profile so the user sees every signal we have.
      lines.push(
        ...renderFinding(finding, idx + 1, colour, {
          alwaysShowRiskProfile: true,
          feedbackHints: options.feedbackHints,
          noColor: options.noColor === true,
          // context ids are file-local; the fingerprint is what
          // `crimes explain` can actually resolve.
          useFingerprintHandle: true,
        }),
      );
      lines.push("");
    });
    // Trim trailing blank from the last finding block.
    if (lines[lines.length - 1] === "") lines.pop();
  }

  return lines.join("\n");
}

function riskLabel(risk: ContextRisk, colour: ColourFns): string {
  const upper = risk.level.toUpperCase();
  switch (risk.level) {
    case "high":
      return colour.red(colour.bold(upper));
    case "medium":
      return colour.yellow(colour.bold(upper));
    case "low":
      return colour.dim(colour.bold(upper));
    case "none":
      return colour.green(colour.bold(upper));
  }
}

function riskCounts(risk: ContextRisk, colour: ColourFns): string {
  if (risk.total === 0) return colour.dim("(0 findings)");
  return colour.dim(
    `(${risk.total} finding${risk.total === 1 ? "" : "s"}: ` +
      `${risk.high} high, ${risk.medium} medium, ${risk.low} low)`,
  );
}
