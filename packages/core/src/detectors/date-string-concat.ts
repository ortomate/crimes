import type { Detector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

/**
 * `"…" + d.dateMethod()` (or vice versa) — building date-shaped
 * strings by hand. Almost always reinvents (badly) something
 * `toISOString()` or `Intl.DateTimeFormat` would do correctly.
 */
export const dateStringConcatDetector: Detector = {
  id: "date_string_concat",
  name: "Date String Sewing",
  description:
    "Flags string concatenation of Date method results — manual date " +
    "formatting that almost always misses padding, locale, or timezone.",
  whyItMatters:
    "Hand-rolled date string building (`year + \"-\" + (month+1) + \"-\" + day`) " +
    "skips zero-padding, ignores timezones, and forgets that months are " +
    "zero-indexed. The output looks fine in dev and fails on day 1 of " +
    "January in production. `toISOString()` or `Intl.DateTimeFormat` give " +
    "you the correctness for free.",

  run(ctx) {
    if (isTestFile(ctx.file)) return [];
    const hits = ctx.parsed.dateStringConcats;
    if (!hits || hits.length === 0) return [];

    const severity: Severity = hits.length >= 3 ? "medium" : "low";
    const sample = hits
      .slice(0, 3)
      .map((h) => `\`"…" + .${h.method}()\` @L${h.line}`);
    const lineList = hits.map((h) => h.line).slice(0, 10);

    const finding: Finding = {
      id: "",
      type: "date_string_concat",
      charge: "Date String Sewing",
      severity,
      confidence: 0.85,
      file: ctx.file,
      lines: [hits[0]!.line, hits[hits.length - 1]!.line],
      summary:
        `${hits.length} hand-rolled string concatenation${hits.length === 1 ? "" : "s"} ` +
        `using Date methods. Manual formatting routinely drops zero-padding, ` +
        `timezone, or zero-indexed month handling.`,
      evidence: [
        ...sample,
        `lines: ${lineList.join(", ")}${hits.length > 10 ? `, …+${hits.length - 10} more` : ""}`,
        `use \`toISOString()\` or \`Intl.DateTimeFormat\` instead of \`+\`-concatenation`,
      ],
      effort: "small",
      fix_shape: "format dates via a single helper; never concatenate fragments",
      scores: {
        severity: severityScoreFor(severity),
        confidence: 0.85,
        agent_risk: round(Math.min(0.4 + (hits.length - 1) * 0.08, 0.75)),
      },
      suggested_actions: [
        {
          kind: "use_iso_or_intl",
          description:
            "Replace the concatenation with `d.toISOString()`, " +
            "`Intl.DateTimeFormat(locale, opts).format(d)`, or a " +
            "timezone-aware library's formatter.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

function severityScoreFor(s: Severity): number {
  return s === "high" ? 0.8 : s === "medium" ? 0.55 : 0.3;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
