import type { ParsedJavaFile, ParsedJavaMethod } from "@crimes/language-java";
import type { LanguageJavaDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { isTestFile } from "../../util/test-files.js";
import { intrinsicFor, plural, severityScore } from "../py/shared.js";

/** Same bound as the Python detector, for the same measured reason. */
const MAX_HELPER_HOPS = 2;

/**
 * `weak_test_signal.java` — JUnit / TestNG test methods that assert
 * nothing.
 *
 * A test is credited when, inside its body, it calls an assertion-shaped
 * method (`assert*`, `fail`, Mockito `verify*`, `expect*`, MockMvc
 * `andExpect`) or uses the `assert` statement; when `@Test(expected = …)`
 * makes the annotation the assertion; or when it calls a same-class
 * helper that asserts, up to {@link MAX_HELPER_HOPS} hops.
 *
 * One deliberate leniency: in a class that extends another, a call with
 * no receiver that does not resolve in this file may be an inherited
 * assertion helper (`assertValidFilm(...)` on a base test class). There
 * is no cross-file Java symbol index yet, so such a test is given the
 * benefit of the doubt rather than accused — the evidence counts how many.
 *
 * `@Disabled` / `@Ignore` tests never run, and are left out of both the
 * numerator and the denominator.
 */
export const weakTestSignalJavaDetector: LanguageJavaDetector = {
  id: "weak_test_signal.java",
  claims: ["file_asserts_nothing"],
  name: "Weak test signal (Java)",
  description:
    "Flags JUnit / TestNG files whose test methods assert nothing, so they pass as " +
    "long as nothing throws.",
  whyItMatters:
    "A test that runs code without asserting on the result only proves the code did " +
    "not throw. It still turns green and still counts toward coverage, so it reads as " +
    "protection that isn't there. An agent changes the code, sees the suite pass, and " +
    "concludes the change was safe.",

  pack: "language-java",
  run(ctx) {
    if (!isTestFile(ctx.file)) return [];
    // An unparsed arm can hide an assertion; the charge is a count.
    if (ctx.parsed.hasSyntaxErrors) return [];

    const tests = ctx.parsed.methods.filter(
      (m) => m.shape === "test_method" && m.hasBody && !m.disabled,
    );
    if (tests.length === 0) return [];

    const helpers = indexHelpers(ctx.parsed);
    const inheritsHelpers = ctx.parsed.types.some((t) => t.superclass !== undefined);
    let creditedViaHelper = 0;
    let givenBenefit = 0;
    const silent = tests.filter((test) => {
      if (test.assertionCount > 0 || test.expectsException) return false;
      const credit = assertsThroughHelpers(test, helpers);
      if (credit === "asserts") {
        creditedViaHelper += 1;
        return false;
      }
      if (credit === "unresolved" && inheritsHelpers) {
        givenBenefit += 1;
        return false;
      }
      return true;
    });
    if (silent.length === 0) return [];

    const severity = pickSeverity(silent.length, tests.length);
    const shown = silent.slice(0, 8);
    const totalAssertions = tests.reduce((n, t) => n + t.assertionCount, 0);
    const evidence = [
      `${silent.length} of ${tests.length} test ${plural(tests.length, "method")} ` +
        `${tests.length === 1 ? "contains" : "contain"} no assertion`,
      ...shown.map(
        (t) => `\`${t.name}\` (lines ${t.startLine}–${t.endLine}) asserts nothing`,
      ),
      ...(silent.length > shown.length ? [`…+${silent.length - shown.length} more`] : []),
      `${totalAssertions} total ${plural(totalAssertions, "assertion")} across ` +
        `${tests.length} ${plural(tests.length, "test")}`,
      ...(creditedViaHelper > 0
        ? [
            `${creditedViaHelper} further ${plural(creditedViaHelper, "test")} assert ` +
              "through a same-class helper and are not counted here",
          ]
        : []),
      ...(givenBenefit > 0
        ? [
            `${givenBenefit} ${plural(givenBenefit, "test")} call an unresolved method ` +
              "that may be an inherited assertion helper, and are not counted here",
          ]
        : []),
      "counted forms: `assert*`, `fail`, `verify*`, `expect*`, `andExpect`, the " +
        "`assert` statement, `@Test(expected = …)`, and any of those reached through " +
        `up to ${MAX_HELPER_HOPS} same-class helper calls`,
    ];

    const finding: Finding = {
      id: "",
      type: "weak_test_signal",
      claim: "file_asserts_nothing",
      charge: "Weak Test Signal",
      severity,
      confidence: 0.85,
      file: ctx.file,
      symbol: shown[0]!.name,
      lines: [silent[0]!.startLine, silent[silent.length - 1]!.endLine],
      summary:
        `${silent.length} of ${tests.length} test ${plural(tests.length, "method")} ` +
        "in this file assert nothing. They pass as long as the code under test does " +
        "not throw, which is not the same as it being correct.",
      evidence,
      effort: "small",
      fix_shape: "assert on the result, not just that it ran",
      scores: {
        severity: severityScore(severity),
        confidence: 0.85,
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
            "only checks that nothing throws, use `assertDoesNotThrow` so the intent " +
            "is explicit.",
          risk: "low",
        },
      ],
    };
    return [finding];
  },
};

function indexHelpers(parsed: ParsedJavaFile): Map<string, ParsedJavaMethod[]> {
  const byName = new Map<string, ParsedJavaMethod[]>();
  for (const m of parsed.methods) {
    const list = byName.get(m.name) ?? [];
    list.push(m);
    byName.set(m.name, list);
  }
  return byName;
}

/**
 * Follow a test's no-receiver calls into same-file methods. Returns
 * `"asserts"` when one reaches an assertion, `"unresolved"` when some call
 * names nothing in this file, or `undefined` when everything resolved and
 * nothing asserted.
 */
function assertsThroughHelpers(
  test: ParsedJavaMethod,
  helpers: Map<string, ParsedJavaMethod[]>,
): "asserts" | "unresolved" | undefined {
  let unresolved = false;
  const seen = new Set<string>([test.name]);
  let frontier = test.localCalls;
  for (let hop = 0; hop < MAX_HELPER_HOPS && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const name of frontier) {
      if (seen.has(name)) continue;
      seen.add(name);
      const defs = helpers.get(name);
      if (!defs) {
        unresolved = true;
        continue;
      }
      for (const def of defs) {
        if (def.assertionCount > 0) return "asserts";
        next.push(...def.localCalls);
      }
    }
    frontier = next;
  }
  return unresolved ? "unresolved" : undefined;
}

function pickSeverity(silent: number, total: number): Severity {
  const share = silent / total;
  if (share >= 0.5 && silent >= 3) return "high";
  if (share >= 0.25 || silent >= 2) return "medium";
  return "low";
}
