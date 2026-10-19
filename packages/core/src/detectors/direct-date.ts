import type { DateUse } from "@crimes/language-js";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";
import { intrinsicFrom } from "../scoring/intrinsic.js";

export const directDateDetector: LanguageJsDetector = {
  id: "direct_date",
  // Only ever "the clock is read here". Declared anyway because
  // `direct_date.py` also emits `naive_datetime` under this `type`, and
  // consumers group by type.
  claims: ["clock_read"],
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

    // `new Date(value)` converts a timestamp that already exists; it does
    // not read the clock. The parser already separates the two —
    // `DateUse.argKind` is `"none"` only for the no-argument form — and
    // this detector's single claim is `clock_read`, so counting a
    // conversion here asserts something untrue rather than something
    // debatable. Field notes, rolecred 2026-09-22:
    // `new Date(evidence.submitted_at)` reported as a system-clock
    // dependency was the finding that cost the reporter's trust in the
    // rest. The string-literal form keeps its own charge,
    // `timezone_unsafe_parse`, which is where parse safety belongs.
    const hits = ctx.parsed.dateNowOrNewDateUses.filter(isClockRead);
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
      claim: "clock_read",
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
        // The Python twin raises this base to 0.55 when a read returns a
        // *naive* datetime. Do not port it: `datetime.now()` without
        // `tz=` yields a value carrying no offset, and JavaScript has no
        // equivalent — `Date.now()` and `new Date()` always produce an
        // absolute instant. There is no condition here to test.
        //
        // The nearest JS hazard is `new Date("2026-12-20")`, where the
        // *string* decides UTC-or-local. That is a different operation
        // and already has its own charge, `timezone_unsafe_parse`.
        agent_risk: scaleRecordedOnly(
          intrinsicFrom(hits.length, { base: 0.45, step: 0.07, cap: 0.85 }),
          compared.length,
        ),
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

/**
 * How much of the clock-read intrinsic a file keeps when none of its
 * readings decides anything.
 *
 * Severity already capped such files at medium, but ranking reads
 * `agent_risk`, which counted every reading alike. On a private
 * Java/Kotlin/Swift estate 75% of clock-read findings were record-only —
 * `setCreated(new Date())` and timestamp columns — and they filled six to
 * eight of the top ten places in each JVM repository, above swallowed
 * errors in payment and persistence code. Shared with the Java, Kotlin
 * and Swift detector so the packs rank the same evidence the same way.
 */
export const RECORDED_ONLY_CLOCK_SCALE = 0.6;

export function scaleRecordedOnly(intrinsic: number, comparedCount: number): number {
  if (comparedCount > 0) return intrinsic;
  return Math.round(intrinsic * RECORDED_ONLY_CLOCK_SCALE * 100) / 100;
}

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

/**
 * Is this use a reading of the current time?
 *
 * `Date.now()` always is. `new Date()` is; `new Date(x)` is not.
 * An absent `argKind` resolves to "clock read": the parser sets it for
 * every `new` use it records, so the only way to reach this branch is a
 * hand-built fixture, and leaving the finding in place is the direction
 * that fails safe.
 */
function isClockRead(use: DateUse): boolean {
  if (use.kind === "now") return true;
  return use.argKind === undefined || use.argKind === "none";
}

function isClockBoundary(file: string): boolean {
  return /(^|\/)(clock|time)\.[cm]?[jt]sx?$/.test(file);
}

function severityScoreFor(s: Severity): number {
  return s === "high" ? 0.8 : s === "medium" ? 0.6 : 0.35;
}
