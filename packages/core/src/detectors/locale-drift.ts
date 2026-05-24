import type { LanguageJsDetector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

const LOCALE_METHODS = new Set([
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
]);

/**
 * Flags `.toLocale*()` calls with no locale argument. The output
 * varies by the host's default locale, which is rarely what the
 * developer intended for any persisted or user-facing string.
 */
export const localeDriftDetector: LanguageJsDetector = {
  id: "locale_drift",
  name: "Host-Locale Drift",
  description:
    "Flags `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` " +
    "calls invoked with no locale argument — output varies by host.",
  whyItMatters:
    "Calling `toLocaleDateString()` with no arguments uses the runtime's " +
    "host locale. The same line renders as \"3/15/2026\" on a US machine, " +
    "\"15/03/2026\" on a UK one, and \"15.03.2026\" on a German one. For " +
    "logs, IDs, persisted text, or anything passed across a network, the " +
    "drift produces silent bugs and broken parsers. For user-facing copy, " +
    "the implicit locale is rarely the right contract either — pick one " +
    "explicitly.",

  pack: "language-js",
  run(ctx) {
    if (isTestFile(ctx.file)) return [];
    const calls = ctx.parsed.dateMethodCalls;
    if (!calls || calls.length === 0) return [];

    const offenders = calls.filter(
      (c) => LOCALE_METHODS.has(c.method) && c.argCount === 0,
    );
    if (offenders.length === 0) return [];

    const severity = pickSeverity(ctx.file, offenders.length);
    const sample = offenders
      .slice(0, 3)
      .map((c) => `${c.receiver}.${c.method}() @L${c.line}`);
    const lineList = offenders.map((c) => c.line).slice(0, 10);

    const finding: Finding = {
      id: "",
      type: "locale_drift",
      charge: "Host-Locale Drift",
      severity,
      confidence: 0.85,
      file: ctx.file,
      lines: [offenders[0]!.line, offenders[offenders.length - 1]!.line],
      summary:
        `${offenders.length} \`toLocale*()\` call${offenders.length === 1 ? "" : "s"} ` +
        `with no locale argument. Output varies by the runtime's default ` +
        `locale, not by anything the code controls.`,
      evidence: [
        ...sample,
        `lines: ${lineList.join(", ")}${offenders.length > 10 ? `, …+${offenders.length - 10} more` : ""}`,
        `pass an explicit locale (e.g. \`'en-US'\`) or use Intl.DateTimeFormat`,
      ],
      effort: "small",
      fix_shape: "centralise locale; one provider for all formatters",
      scores: {
        severity: severityScoreFor(severity),
        confidence: 0.85,
        agent_risk: round(Math.min(0.4 + (offenders.length - 1) * 0.07, 0.8)),
      },
      suggested_actions: [
        {
          kind: "fix_locale_arg",
          description:
            "Pass an explicit BCP-47 locale string, or move to " +
            "`Intl.DateTimeFormat` with locale + options.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

/**
 * In UI-facing directories the absence of a locale tends to be more
 * impactful (renders are user-visible). Anywhere else, default low
 * and escalate only on recurring patterns.
 */
function pickSeverity(file: string, count: number): Severity {
  const userFacing = /(?:^|\/)(?:ui|components|pages|app|routes|views)(?:\/|$)/.test(file);
  if (userFacing) return count >= 5 ? "high" : "medium";
  return count >= 3 ? "medium" : "low";
}

function severityScoreFor(s: Severity): number {
  return s === "high" ? 0.8 : s === "medium" ? 0.55 : 0.3;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
