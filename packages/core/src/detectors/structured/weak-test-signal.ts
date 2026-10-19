import type { Detector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { isTestFile } from "../../util/test-files.js";
import { intrinsicFor, plural, severityScore } from "../py/shared.js";
import type {
  LanguageProfile,
  StructuredContext,
  StructuredFile,
  StructuredMethod,
  StructuredPack,
} from "./surface.js";

/** `ParserPerformanceTest`, `benchmarkFolding`, `testThroughput`. */
const BENCHMARK_NAME = /benchmark|performance|throughput/i;

/** Same bound as the Python detector, for the same measured reason. */
const MAX_HELPER_HOPS = 2;

/**
 * `weak_test_signal` for a structured-surface language — test methods
 * that assert nothing. What counts as an assertion is the parser's call
 * (`assertionCount`); this follows same-class helpers and decides.
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
 * is no cross-file symbol index for these packs yet, so such a test is given the
 * benefit of the doubt rather than accused — the evidence counts how many.
 *
 * `@Disabled` / `@Ignore` tests never run, and are left out of both the
 * numerator and the denominator.
 */
export function makeWeakTestSignalDetector<P extends StructuredPack>(
  profile: LanguageProfile<P>,
): Extract<Detector, { pack: P }> {
  const cfg = profile.weakTestSignal;
  const unit = cfg.unitNoun;
  const detector = {
    id: `weak_test_signal.${profile.suffix}`,
    claims: ["file_asserts_nothing"],
    name: `Weak test signal (${profile.label})`,
    description: cfg.description,
    whyItMatters: cfg.whyItMatters,
    pack: profile.pack,
    run(ctx: StructuredContext): Finding[] {
      if (!isTestFile(ctx.file)) return [];
      // An unparsed arm can hide an assertion; the charge is a count.
      if (ctx.parsed.hasSyntaxErrors) return [];

      // Benchmarks and performance tests time code rather than check it, so
      // their silence is correct; same exemption as the Python detector, by
      // name since JUnit marks them with nothing else.
      const tests = ctx.parsed.methods.filter(
        (m) =>
          m.shape === "test_method" &&
          m.hasBody &&
          !m.disabled &&
          !BENCHMARK_NAME.test(m.name) &&
          !BENCHMARK_NAME.test(m.className ?? ""),
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
        `${silent.length} of ${tests.length} test ${plural(tests.length, unit)} ` +
          `${tests.length === 1 ? "contains" : "contain"} no assertion`,
        ...shown.map(
          (t) => `\`${t.name}\` (lines ${t.startLine}–${t.endLine}) asserts nothing`,
        ),
        ...(silent.length > shown.length
          ? [`…+${silent.length - shown.length} more`]
          : []),
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
        `counted forms: ${cfg.countedForms}, and any of those reached through ` +
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
          `${silent.length} of ${tests.length} test ${plural(tests.length, unit)} ` +
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
            description: cfg.strengthenAdvice,
            risk: "low",
          },
        ],
      };
      return [finding];
    },
  };
  return detector as unknown as Extract<Detector, { pack: P }>;
}

function indexHelpers(parsed: StructuredFile): Map<string, StructuredMethod[]> {
  const byName = new Map<string, StructuredMethod[]>();
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
  test: StructuredMethod,
  helpers: Map<string, StructuredMethod[]>,
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
