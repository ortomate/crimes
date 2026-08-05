import type { DateUse } from "@crimes/language-js";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

export const directDateDetector: LanguageJsDetector = {
  id: "direct_date",
  name: "Direct Date.now() / new Date()",
  description:
    "Flags direct uses of Date.now() and new Date() — these make code hard to test and " +
    "introduce hidden timezone coupling.",
  whyItMatters:
    "Direct clock access makes behaviour non-deterministic in tests and " +
    "couples logic to whichever timezone the process happens to run in. " +
    "Injecting a clock keeps domain code reproducible and lets tests assert " +
    "exact timing without freezing the whole process.",

  pack: "language-js",
  run(ctx) {
    // Test files intentionally inject dates as `now: () => new Date(NOW_ISO)`
    // — flagging that pattern is a false positive. Domain code is where
    // direct clock access matters.
    if (isTestFile(ctx.file)) return [];
    if (isClockBoundary(ctx.file)) return [];

    const hits = ctx.parsed.dateNowOrNewDateUses;
    if (hits.length === 0) return [];

    // Split the uses by what the clock reading is *for*. A reading that
    // decides a branch changes what the program does; one that is
    // recorded or rendered changes only what it outputs. Both are
    // non-deterministic, and they are not the same finding.
    const compared = hits.filter((h: DateUse) => h.usage !== "value");
    const recorded = hits.filter((h: DateUse) => h.usage === "value");

    const severity = pickSeverity(hits.length, compared.length);
    const lineList = hits.map((h: DateUse) => h.line).slice(0, 10);
    const nowCount = hits.filter((h) => h.kind === "now").length;
    const newCount = hits.length - nowCount;
    const breakdown =
      nowCount > 0 && newCount > 0
        ? `${nowCount}× Date.now(), ${newCount}× new Date()`
        : nowCount > 0
          ? `${nowCount}× Date.now()`
          : `${newCount}× new Date()`;

    // The line that tells a reader which of the N uses to look at first.
    // Field notes from choreograph.cc: `JobDetail.tsx` reported "9×
    // Date.now(), 4× new Date()" and nothing else, which reads as
    // undifferentiated noise — the reporter concluded "essentially all
    // of it is display formatting". Two of the thirteen are poll
    // timeouts (`if (Date.now() - startedAt >= VIDEO_POLL_TIMEOUT_MS)`),
    // which is the risky shape exactly. The count was right and the
    // evidence could not say so.
    const usageLine =
      compared.length > 0 && recorded.length > 0
        ? `${compared.length} decide a branch or comparison (lines ${compared
            .map((h) => h.line)
            .slice(0, 6)
            .join(", ")}); ${recorded.length} only record or render the reading`
        : compared.length > 0
          ? `all ${compared.length} decide a branch or comparison`
          : `none decide a branch — all ${recorded.length} record or render the reading`;

    const finding: Finding = {
      id: "",
      type: "direct_date",
      charge: "Temporal Recklessness",
      severity,
      confidence: 0.9,
      file: ctx.file,
      lines: [hits[0]!.line, hits[hits.length - 1]!.line],
      summary:
        `${hits.length} direct use${hits.length === 1 ? "" : "s"} of Date.now()/new Date(). ` +
        `Reading the system clock in domain code makes behaviour non-deterministic and couples ` +
        `tests to wall time.`,
      evidence: [
        breakdown,
        usageLine,
        `lines: ${lineList.join(", ")}${hits.length > 10 ? `, …+${hits.length - 10} more` : ""}`,
        compared.length > 0
          ? `a reading in a comparison changes what the code does — tests cannot pin the behaviour without controlling the clock`
          : `these readings change what the code outputs, not what it does — lower risk, but still untestable without a fixed clock`,
      ],
      effort: "small",
      fix_shape: "inject a clock; pass through the domain boundary",
      scores: {
        severity: severityScoreFor(severity),
        confidence: 0.9,
        agent_risk: round(Math.min(0.45 + (hits.length - 1) * 0.07, 0.85)),
      },
      suggested_actions: [
        {
          kind: "inject_clock",
          description:
            "Inject a clock/now() abstraction so domain code is deterministic in tests and " +
            "free of hidden temporal coupling.",
          risk: "low",
        },
      ],
    };

    return [finding];
  },
};

function pickSeverity(count: number, comparedCount: number): Severity {
  // A single use is noise. Two or more direct clock reads in one file is a
  // recurring pattern — the whole module is bound to wall time. Eight or more
  // is pervasive enough to call high.
  //
  // A file whose readings are *all* recorded or rendered caps at medium
  // however many there are. Thirteen `new Date().toISOString()` calls
  // writing timestamp columns is a real testability cost and a real
  // finding; it is not the same thing as a poll timeout, and calling it
  // `high` on volume alone is what made this detector read as noise on a
  // component that formats a lot of dates.
  if (comparedCount === 0) return count >= 2 ? "medium" : "low";
  if (count >= 8) return "high";
  if (count >= 2) return "medium";
  return "low";
}

function isClockBoundary(file: string): boolean {
  return /(^|\/)(clock|time)\.[cm]?[jt]sx?$/.test(file);
}

function severityScoreFor(s: Severity): number {
  return s === "high" ? 0.8 : s === "medium" ? 0.6 : 0.35;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
