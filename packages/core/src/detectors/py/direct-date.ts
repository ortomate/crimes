import type { LanguagePyDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { isTestFile } from "../../util/test-files.js";
import { intrinsicFor, lineList, severityScore } from "./shared.js";

/**
 * The Python analogue of the JS `direct_date` charge, with one
 * language-specific twist the JS version has no equivalent for:
 * `datetime.now()` without a `tz=` argument returns a **naive**
 * datetime. It carries no offset at all, so comparing it against an
 * aware datetime raises `TypeError` at runtime and comparing it against
 * another naive one silently assumes both came from the same zone.
 *
 * A tz-aware read (`datetime.now(timezone.utc)`) is still non-
 * deterministic in tests, but it is not the same bug class — so it is
 * flagged at lower severity than a naive one rather than not at all.
 */
export const directDatePyDetector: LanguagePyDetector = {
  id: "direct_date.py",
  name: "Direct clock read (Python)",
  description:
    "Flags datetime.now() / date.today() / time.time() in domain code, and calls out " +
    "reads that produce a naive datetime with no timezone attached.",
  whyItMatters:
    "Reading the system clock inside domain code makes behaviour depend on when the " +
    "code runs, so tests either pin wall time globally or accept flakiness at date " +
    "boundaries. Python adds a second hazard: `datetime.now()` without `tz=` returns " +
    "a naive datetime carrying no offset. Comparing that against an aware datetime " +
    "raises TypeError, and comparing it against another naive one silently assumes " +
    "both came from the same zone — which is true on a developer laptop and false in " +
    "production. Passing a clock in makes the code deterministic and forces the " +
    "timezone question to be answered once, explicitly.",

  pack: "language-py",
  run(ctx) {
    // Tests legitimately construct fixed timestamps; flagging that is
    // noise. Same policy as the JS detector.
    if (isTestFile(ctx.file)) return [];
    if (isClockBoundary(ctx.file)) return [];

    const hits = ctx.parsed.dateCalls;
    if (hits.length === 0) return [];

    const naive = hits.filter((h) => !h.timezoneAware && h.kind !== "time");
    const severity = pickSeverity(hits.length, naive.length);

    const byKind = new Map<string, number>();
    for (const h of hits) byKind.set(h.callee, (byKind.get(h.callee) ?? 0) + 1);
    const breakdown = [...byKind.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([callee, n]) => `${n}× ${callee}()`)
      .join(", ");

    const evidence: string[] = [
      breakdown,
      lineList(hits.map((h) => h.line)),
      "each call observes wall time at runtime — a test cannot pin a fixed moment without patching the module",
    ];
    if (naive.length > 0) {
      evidence.push(
        `${naive.length} of ${hits.length} return a naive datetime (no tz= argument) — ` +
          "comparing one against an aware datetime raises TypeError",
      );
      evidence.push(
        `naive at ${lineList(
          naive.map((h) => h.line),
          5,
        )}`,
      );
    }
    const utcnow = hits.filter((h) => h.kind === "utcnow");
    if (utcnow.length > 0) {
      evidence.push(
        `${utcnow.length}× utcnow() — deprecated since Python 3.12; returns naive UTC, ` +
          "which reads as local time to every downstream comparison",
      );
    }

    const finding: Finding = {
      id: "",
      type: "direct_date",
      charge: "Temporal Recklessness",
      severity,
      confidence: 0.9,
      file: ctx.file,
      lines: [hits[0]!.line, hits[hits.length - 1]!.line],
      summary:
        `${hits.length} direct clock read${hits.length === 1 ? "" : "s"}` +
        (naive.length > 0
          ? `, ${naive.length} of which produce${naive.length === 1 ? "s" : ""} a naive datetime` +
            " with no timezone attached"
          : "") +
        ". Domain code that reads the clock cannot be tested at a fixed moment.",
      evidence,
      effort: "small",
      fix_shape: "inject a clock; pass tz= explicitly at the boundary",
      scores: {
        severity: severityScore(severity),
        confidence: 0.9,
        // Ramps with the number of reads, plus a surcharge for naive
        // ones — those carry a real runtime failure mode, not just a
        // testability cost.
        // Cap reconciled with the universal detector in 0.25.5 (0.88 →
        // 0.85). Base and step already agreed on the non-naive branch,
        // and 0.45 is the value `detector-defaults.ts` publishes for
        // this charge; the naive surcharge stays Python-only because
        // JavaScript has no naive datetime — see the note in the
        // universal detector.
        agent_risk: intrinsicFor({
          count: hits.length,
          base: naive.length > 0 ? 0.55 : 0.45,
          step: 0.07,
          cap: 0.85,
        }),
      },
      suggested_actions: [
        {
          kind: "inject_clock",
          description:
            "Take a `now()` callable (or a Clock protocol) as a parameter or " +
            "constructor argument so tests can supply a fixed instant.",
          risk: "low",
        },
        ...(naive.length > 0
          ? [
              {
                kind: "make_timezone_explicit" as const,
                description:
                  "Pass `tz=timezone.utc` (or the zone the domain actually means) so " +
                  "the returned datetime is aware and comparisons stay well-defined.",
                risk: "low" as const,
              },
            ]
          : []),
      ],
    };

    return [finding];
  },
};

function pickSeverity(total: number, naive: number): Severity {
  // Naive reads are the genuine bug class, so they drive severity
  // harder than raw call count does.
  if (naive >= 4 || total >= 8) return "high";
  if (naive >= 1 || total >= 2) return "medium";
  return "low";
}

/**
 * A module whose whole job is to be the clock is where the clock is
 * supposed to be read. Mirrors the JS detector's `clock.ts` / `time.ts`
 * exemption.
 */
function isClockBoundary(file: string): boolean {
  return /(^|\/)(clock|time|_?datetime_?)\.pyi?$/.test(file);
}
