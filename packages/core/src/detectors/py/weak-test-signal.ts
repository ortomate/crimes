import { z } from "zod";
import type { LanguagePyDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { isTestFile } from "../../util/test-files.js";
import { intrinsicFor, plural, severityScore } from "./shared.js";

const optionsSchema = z
  .object({
    minAssertionsPerTest: z.number().positive().optional(),
  })
  .strict();

const DEFAULT_MIN_ASSERTIONS_PER_TEST = 1;

export const weakTestSignalPyDetector: LanguagePyDetector = {
  id: "weak_test_signal.py",
  name: "Weak test signal (Python)",
  description:
    "Flags pytest / unittest files whose test functions assert nothing, or assert far " +
    "less often than they have tests.",
  whyItMatters:
    "A test that runs code without asserting on the result only proves the code did " +
    "not raise. It still turns green in CI and still counts toward coverage, so it " +
    "reads as protection that isn't there — which is worse than no test, because it " +
    "stops anyone from writing the real one. For an agent the effect is direct: it " +
    "will change the code under test, see the suite pass, and conclude the change was " +
    "safe. `pytest` makes this especially easy to do by accident, because a function " +
    "with no assert is a passing test rather than an error.",

  pack: "language-py",
  optionsSchema,
  run(ctx) {
    // Only meaningful on files that are themselves tests.
    if (!isTestFile(ctx.file)) return [];
    // A partial parse gives an untrustworthy assertion count, and the
    // whole charge is a count. Better to stay quiet than to accuse a
    // file on numbers we can't stand behind.
    if (ctx.parsed.hasSyntaxErrors) return [];

    const tests = ctx.parsed.functions.filter(
      (fn) => fn.shape === "test_function" && fn.name !== undefined && /^test/.test(fn.name),
    );
    if (tests.length === 0) return [];

    // Attribute assertions by line span rather than by the innermost
    // enclosing function's name. A test that asserts inside a local
    // helper —
    //
    //     def test_totals():
    //         def check(x): assert x > 0
    //         check(compute())
    //
    // — records the assertion against `check`, so name-keyed counting
    // would report `test_totals` as asserting nothing. It is a real
    // test; accusing it would be exactly the kind of false positive
    // that gets a detector disabled.
    const silent = tests.filter(
      (fn) =>
        !ctx.parsed.assertions.some(
          (a) => a.line >= fn.startLine && a.line <= fn.endLine,
        ),
    );
    if (silent.length === 0) return [];

    const minPerTest = readMinAssertions(ctx.config);
    const totalAssertions = ctx.parsed.assertions.length;
    const ratio = totalAssertions / tests.length;
    const severity = pickSeverity(silent.length, tests.length);

    const shown = silent.slice(0, 8);
    const evidence: string[] = [
      `${silent.length} of ${tests.length} test ${plural(tests.length, "function")} contain no assertion`,
      ...shown.map((fn) => `\`${fn.name}\` (lines ${fn.startLine}–${fn.endLine}) asserts nothing`),
      ...(silent.length > shown.length ? [`…+${silent.length - shown.length} more`] : []),
      `${totalAssertions} total ${plural(totalAssertions, "assertion")} across ${tests.length} ` +
        `${plural(tests.length, "test")} (${ratio.toFixed(1)} per test, expected ≥ ${minPerTest})`,
      "counted forms: bare `assert`, unittest `self.assert*`, and `pytest.raises`",
    ];

    const finding: Finding = {
      id: "",
      type: "weak_test_signal",
      charge: "Weak Test Signal",
      severity,
      confidence: 0.85,
      file: ctx.file,
      ...(shown[0]?.name !== undefined ? { symbol: shown[0].name } : {}),
      lines: [silent[0]!.startLine, silent[silent.length - 1]!.endLine],
      summary:
        `${silent.length} of ${tests.length} test ${plural(tests.length, "function")} ` +
        "in this file assert nothing. They pass as long as the code under test does " +
        "not raise, which is not the same as it being correct.",
      evidence,
      effort: "small",
      fix_shape: "assert on the result, not just that it ran",
      scores: {
        severity: severityScore(severity),
        confidence: 0.85,
        // Scales with how much of the file is hollow rather than the
        // raw count — 3 silent tests out of 4 is a much stronger signal
        // than 3 out of 60.
        agent_risk: intrinsicFor({
          count: Math.max(1, Math.round((silent.length / tests.length) * 10)),
          base: 0.32,
          step: 0.045,
          cap: 0.72,
        }),
      },
      suggested_actions: [
        {
          kind: "strengthen_assertions",
          description:
            "Assert on the returned value or the observable side effect. If the test " +
            "genuinely only checks that no exception is raised, say so explicitly with " +
            "a comment so the next reader knows it was deliberate.",
          risk: "low",
        },
      ],
    };

    return [finding];
  },
};

function pickSeverity(silent: number, total: number): Severity {
  const share = silent / total;
  if (share >= 0.5 && silent >= 3) return "high";
  if (share >= 0.25 || silent >= 2) return "medium";
  return "low";
}

function readMinAssertions(
  config: Parameters<LanguagePyDetector["run"]>[0]["config"],
): number {
  const raw = config.detectors?.options?.["weak_test_signal.py"];
  const parsed = optionsSchema.safeParse(raw ?? {});
  if (!parsed.success) return DEFAULT_MIN_ASSERTIONS_PER_TEST;
  return parsed.data.minAssertionsPerTest ?? DEFAULT_MIN_ASSERTIONS_PER_TEST;
}
