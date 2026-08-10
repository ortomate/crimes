import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";
import { intrinsicFrom } from "../scoring/intrinsic.js";

const SENSITIVE_PATH_RE =
  /(?:^|\/)(?:billing|invoice|invoices|schedul(?:e|ing|er)|cron|payment|payments|subscription|subscriptions)(?:\/|$|\.[a-z]+$)/i;

/**
 * `+`/`-` arithmetic on millisecond timestamps using day-level constants
 * (`+ 86400000`, `- 24 * 60 * 60 * 1000`, etc.). The reader almost
 * always thinks "add 1 day", but daylight-saving transitions, leap
 * seconds, and timezone changes mean a day isn't always 86,400,000ms.
 */
export const dstNaiveArithmeticDetector: LanguageJsDetector = {
  id: "dst_naive_arithmetic",
  name: "DST-Naive Day Math",
  description:
    "Flags `+` / `-` arithmetic with day-level millisecond constants " +
    "(86,400,000 ≈ 1 day, etc.).",
  whyItMatters:
    'A "day" isn\'t always 86,400,000 ms — DST transitions skip an hour ' +
    "in spring and repeat an hour in autumn. Adding constants to a " +
    "timestamp picks up that drift silently. Tests that don't straddle a " +
    "transition won't catch it; the report runs differently in March or " +
    "October. For day-level math, use a timezone-aware library that " +
    "knows about the calendar — Luxon, Temporal, date-fns-tz, etc.",

  pack: "language-js",
  run(ctx) {
    if (isTestFile(ctx.file)) return [];
    const hits = ctx.parsed.dateArithmetic;
    if (!hits || hits.length === 0) return [];

    const severity = pickSeverity(ctx.file, hits.length);
    const sample = hits
      .slice(0, 3)
      .map((h) => `${h.kind === "add" ? "+" : "-"} ${h.operand} (${h.unit}) @L${h.line}`);
    const lineList = hits.map((h) => h.line).slice(0, 10);

    const finding: Finding = {
      id: "",
      type: "dst_naive_arithmetic",
      charge: "DST-Naive Day Math",
      severity,
      confidence: 0.8,
      file: ctx.file,
      lines: [hits[0]!.line, hits[hits.length - 1]!.line],
      summary:
        `${hits.length} day-level millisecond constant${hits.length === 1 ? "" : "s"} ` +
        `in arithmetic. A day isn't 86,400,000 ms on DST-transition days; ` +
        `manual ms math drifts silently.`,
      evidence: [
        ...sample,
        `lines: ${lineList.join(", ")}${hits.length > 10 ? `, …+${hits.length - 10} more` : ""}`,
        SENSITIVE_PATH_RE.test(ctx.file)
          ? `file looks like scheduling/billing code — drift here directly affects users`
          : `use a calendar-aware library (Luxon, Temporal, date-fns-tz) for day math`,
      ],
      effort: "medium",
      fix_shape: "use a DST-aware library; never add seconds to a wall-clock date",
      scores: {
        severity: severityScoreFor(severity),
        confidence: 0.8,
        agent_risk: intrinsicFrom(hits.length, { base: 0.5, step: 0.08, cap: 0.85 }),
      },
      suggested_actions: [
        {
          kind: "use_calendar_aware_lib",
          description:
            "Replace ms-arithmetic with a timezone-aware addDays/subtract " +
            "operation that knows about DST and leap years.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

function pickSeverity(file: string, count: number): Severity {
  if (SENSITIVE_PATH_RE.test(file)) return "high";
  return count >= 3 ? "high" : "medium";
}

function severityScoreFor(s: Severity): number {
  return s === "high" ? 0.8 : s === "medium" ? 0.6 : 0.35;
}
