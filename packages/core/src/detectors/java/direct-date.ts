import type { LanguageJavaDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { classifyScope } from "../../util/scope-class.js";
import { intrinsicFor, lineList, severityScore } from "../py/shared.js";

/**
 * The Java form of `direct_date`: domain code reading the wall clock
 * through `System.currentTimeMillis()`, `new Date()`, `Instant.now()`,
 * `LocalDateTime.now()` and friends, instead of a `java.time.Clock` it
 * was handed.
 *
 * `now(clock)` is the remedy and is not reported; `now(zone)` still
 * reads the system clock and is. `System.nanoTime()` measures elapsed
 * time and is never reported.
 */
export const directDateJavaDetector: LanguageJavaDetector = {
  id: "direct_date.java",
  claims: ["clock_read"],
  name: "Direct clock read (Java)",
  description:
    "Flags System.currentTimeMillis(), new Date(), Instant.now() and other wall-clock " +
    "reads in domain code that could take an injected java.time.Clock.",
  whyItMatters:
    "Reading the system clock inside domain code makes behaviour depend on when the " +
    "code runs, so a test either cannot pin a moment or has to mock static methods. " +
    "Bugs at day, month and DST boundaries then only appear in production. Passing a " +
    "`Clock` in makes the code deterministic and puts the time-zone decision in one place.",

  pack: "language-java",
  run(ctx) {
    if (classifyScope(ctx.file) !== "production") return [];
    if (isClockBoundary(ctx.file)) return [];
    const hits = ctx.parsed.clockReads;
    if (hits.length === 0) return [];

    const byCallee = new Map<string, number>();
    for (const h of hits) byCallee.set(h.callee, (byCallee.get(h.callee) ?? 0) + 1);
    const breakdown = [...byCallee.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([callee, n]) => `${n}× ${callee}()`)
      .join(", ");
    const severity = pickSeverity(hits.length);

    const finding: Finding = {
      id: "",
      type: "direct_date",
      charge: "Temporal Recklessness",
      severity,
      confidence: 0.9,
      file: ctx.file,
      lines: [hits[0]!.line, hits[hits.length - 1]!.line],
      claim: "clock_read",
      summary:
        `${hits.length} direct clock read${hits.length === 1 ? "" : "s"}. Domain code ` +
        "that reads the clock cannot be tested at a fixed moment.",
      evidence: [
        breakdown,
        lineList(hits.map((h) => h.line)),
        "each call observes wall time at runtime — a test cannot pin a fixed moment " +
          "without mocking a static method",
      ],
      effort: "small",
      fix_shape: "inject a java.time.Clock; read time through it",
      scores: {
        severity: severityScore(severity),
        confidence: 0.9,
        agent_risk: intrinsicFor({
          count: hits.length,
          base: 0.45,
          step: 0.07,
          cap: 0.85,
        }),
      },
      suggested_actions: [
        {
          kind: "inject_clock",
          description:
            "Take a `java.time.Clock` in the constructor and call `Instant.now(clock)` " +
            "/ `clock.millis()`, so tests can pass `Clock.fixed(...)`.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

function pickSeverity(total: number): Severity {
  if (total >= 8) return "high";
  if (total >= 2) return "medium";
  return "low";
}

/** A class whose job is to be the clock is where the clock is read. */
function isClockBoundary(file: string): boolean {
  return /(?:^|\/)[A-Za-z]*(?:Clock|TimeSource|TimeProvider|DateUtils?)\.java$/.test(
    file,
  );
}
