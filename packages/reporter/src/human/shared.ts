import type { Finding, Severity } from "@crimes/core";
import { fingerprintFinding } from "@crimes/core";
import pc from "picocolors";
import { formatBlastRadius, formatChurn } from "./score-format.js";

/**
 * Cross-report visual primitives shared by every human formatter. Lives
 * here so each `human/<report>.ts` file only knows about its own report
 * shape — the renderer wiring (colour, finding rendering, feedback
 * hints, risk-profile lines) is centralised.
 */

export type ColourFns = typeof pc;

export { pc };

export function plainColour(): ColourFns {
  const passthrough = (s: string): string => s;
  return new Proxy({} as ColourFns, {
    get: () => passthrough,
  });
}

/**
 * Inline "Give feedback: ..." hint configuration. When set on
 * {@link HumanReportOptions} (or its `Context` / `Diff` / `Baseline`
 * equivalents), every rendered finding gets a one-line trailing hint
 * pointing at the `crimes feedback` command — or, for resurfaced
 * findings, the alternate "Previously marked fp" prompt.
 *
 * Suppression rules (matches the 0.6.0 stderr breadcrumb):
 *   • `noColor: true` on the report options suppresses hints entirely
 *     (so piped / `--no-color` invocations stay clean).
 *   • `disabled: true` here suppresses regardless of TTY.
 *   • `entriesByDetector[finding.type] >= capPerDetector` suppresses
 *     for that one detector — "once you've recorded 5 verdicts on
 *     `large_function`, you don't need the prompt anymore."
 *
 * JSON output never goes through this renderer, so the structured
 * contract is unaffected.
 */
export interface FeedbackHintOptions {
  /** Per-detector count of feedback entries from `.crimes/feedback.jsonl`. */
  entriesByDetector?: Record<string, number>;
  /** Force-disable hints (still respects noColor). */
  disabled?: boolean;
  /** Threshold above which to suppress the hint. Default 5. */
  capPerDetector?: number;
}

export const DEFAULT_FEEDBACK_HINT_CAP = 5;
export const RELATED_FILES_DISPLAY_CAP = 5;

/**
 * Shared semantic glyph vocabulary for human reporters. JSON output
 * never goes through this — these are presentation-only marks.
 *
 * `logo` is intentionally identical to `new`: ⊕ is both the diff-like
 * "addition" mark and a close visual match for the product favicon, so
 * it doubles as a terminal-context logo where a heading or banner can
 * carry it without becoming noisy. Use sparingly; severity glyphs and
 * `Charge:` markers carry most of the load already.
 *
 * Suppressed in `noColor` mode by callers — keeps piped output, CI
 * logs, and `--no-color` invocations free of Unicode decoration.
 */
export const HUMAN_GLYPHS = {
  logo: "⊕",
  new: "⊕",
  fixed: "⊖",
  unchanged: "≡",
  charge: "§",
  related: "⧉",
  worse: "▲",
  cleaner: "▼",
  mixed: "◆",
} as const;

/**
 * Single-glyph severity prefix for human output. Suppressed when
 * `noColor` is true so piped output, CI logs, and `--no-color` stay
 * emoji-free. JSON output never goes through this path.
 *
 * Glyphs are mirrored on the severity heading and on each finding's
 * title line, so a fast skim ("where are the sirens?") works on the
 * report without reading prose.
 */
export const SEVERITY_GLYPH: Record<Severity, string> = {
  high: "🚨",
  medium: "⚠️ ",
  low: "🔎",
};

export function severityGlyph(severity: Severity, noColor: boolean): string {
  return noColor ? "" : `${SEVERITY_GLYPH[severity]} `;
}

export function renderFinding(
  finding: Finding,
  n: number,
  colour: ColourFns,
  options: {
    alwaysShowRiskProfile?: boolean;
    feedbackHints?: FeedbackHintOptions;
    noColor?: boolean;
  } = {},
): string[] {
  const lineRange = finding.lines
    ? `:${finding.lines[0]}${finding.lines[1] !== finding.lines[0] ? `-${finding.lines[1]}` : ""}`
    : "";
  const location = `${finding.file}${lineRange}`;
  const symbol = finding.symbol ? ` (${finding.symbol})` : "";

  const out: string[] = [];
  const noColor = options.noColor === true;
  const glyph = severityGlyph(finding.severity, noColor);
  const chargeLabel = noColor ? "Charge:" : `${HUMAN_GLYPHS.charge} Charge:`;
  out.push(
    `  ${glyph}${colour.bold(`${n}.`)} ${colour.cyan(location)}${colour.dim(symbol)}`,
  );
  out.push(`     ${colour.bold(chargeLabel)} ${finding.charge}`);
  const riskLine = renderRiskProfileLine(finding, colour, options);
  if (riskLine) out.push(riskLine);
  out.push(`     ${colour.bold("Summary:")} ${finding.summary}`);
  if (finding.evidence.length > 0) {
    out.push(`     ${colour.bold("Evidence:")}`);
    for (const ev of finding.evidence) {
      out.push(`       · ${colour.dim(ev)}`);
    }
  }
  if (finding.related_files && finding.related_files.length > 0) {
    const shown = finding.related_files.slice(0, RELATED_FILES_DISPLAY_CAP);
    const hidden = finding.related_files.length - shown.length;
    const alsoTouchesLabel = noColor
      ? "Also touches:"
      : `${HUMAN_GLYPHS.related} Also touches:`;
    out.push(`     ${colour.bold(alsoTouchesLabel)}`);
    for (const rel of shown) {
      out.push(`       · ${colour.cyan(rel)}`);
    }
    if (hidden > 0) {
      out.push(`       ${colour.dim(`… and ${hidden} more (see JSON output)`)}`);
    }
  }
  if (finding.suppressed === true) {
    out.push(
      `     ${colour.dim("Suppressed:")} ${finding.suppression_reason ?? "(no reason)"}`,
    );
  }
  out.push(
    `     ${colour.dim(`id=${finding.id}  confidence=${finding.confidence.toFixed(2)}`)}`,
  );
  appendFeedbackHint(out, finding, colour, options);
  return out;
}

/**
 * Append the inline `Give feedback: ...` hint (or the resurfaced
 * variant) to a rendered finding's line buffer. Mutates `out`. Returns
 * silently when hints are disabled, when `noColor` is set, or when the
 * per-detector cap is met.
 */
export function appendFeedbackHint(
  out: string[],
  finding: Finding,
  colour: ColourFns,
  options: { feedbackHints?: FeedbackHintOptions; noColor?: boolean },
): void {
  if (options.noColor) return;
  const hints = options.feedbackHints;
  if (!hints || hints.disabled) return;
  const cap = hints.capPerDetector ?? DEFAULT_FEEDBACK_HINT_CAP;
  const count = hints.entriesByDetector?.[finding.type] ?? 0;
  if (count >= cap) return;

  const fp = fingerprintFinding(finding);
  if (finding.previously_suppressed && finding.previous_suppression) {
    out.push(
      `     ${colour.dim(`⚠ Previously marked fp in ${finding.previous_suppression.pinned_version}. Re-confirm: crimes feedback ${fp} --verdict {tp|fp}`)}`,
    );
    out.push(
      `     ${colour.dim("↳ See `crimes feedback recheck` to walk all resurfaced findings.")}`,
    );
    return;
  }
  out.push(
    `     ${colour.dim(`Give feedback: crimes feedback ${fp} --verdict {tp|fp}`)}`,
  );
}

/**
 * One-line "Risk profile" block surfacing the per-finding scoring signals
 * the 0.6.0 release added. Shown only when at least one of churn,
 * test_gap, or blast_radius is notable — keeps the report tidy on
 * low-signal findings — or always when `--all` was passed.
 *
 * test_gap is rendered as a quartile label (top-quartile / ~median /
 * bottom-quartile) because the underlying score is repo-relative
 * quartile-ranked — the numeric form carries no additional meaning for a
 * human reader.
 */
export function renderRiskProfileLine(
  finding: Finding,
  colour: ColourFns,
  options: { alwaysShowRiskProfile?: boolean },
): string | undefined {
  const { churn, test_gap, blast_radius, blast_radius_importers } = finding.scores;
  if (churn === undefined && test_gap === undefined && blast_radius === undefined) {
    return undefined;
  }
  const notable =
    (churn ?? 0) > 0.5 || (test_gap ?? 0) >= 0.75 || (blast_radius ?? 0) > 0.5;
  if (!notable && !options.alwaysShowRiskProfile) return undefined;
  const parts = [
    `churn ${formatChurn(churn ?? 0)}`,
    `test gap ${testGapLabel(test_gap)}`,
    `blast ${formatBlastRadius(blast_radius ?? 0, blast_radius_importers)}`,
  ];
  return `     ${colour.bold("Risk profile:")} ${colour.dim(parts.join(" · "))}`;
}

function testGapLabel(score: number | undefined): string {
  if (score === undefined) return "unknown";
  if (score >= 0.75) return "top-quartile";
  if (score <= 0.25) return "bottom-quartile";
  return "~median";
}
