import type { ParsedPyFile, ParsedPyFunction } from "@crimes/language-py";
import { z } from "zod";
import type { LanguagePyDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { isTestFile } from "../../util/test-files.js";
import { intrinsicFor, plural, severityScore } from "./shared.js";

/**
 * `weak_test_signal.py` — test functions that assert nothing.
 *
 * ## What counts as an assertion
 *
 * A test is credited when any of these appears **inside its line span**:
 * a bare `assert` statement, a `unittest` `self.assert*` call,
 * `self.fail(...)` / `pytest.fail(...)`, `pytest.raises(...)`,
 * `pytest.warns(...)`, or pydantic's `model_dump_json(warnings='error')`
 * — a call written only for its raise-on-bad-data behaviour.
 *
 * It is credited without reading its body at all when the test carries
 * `@pytest.mark.xfail`, because that marker is itself the expectation.
 *
 * It is also credited when any of those is reached **through a call**,
 * which is the change that made this detector usable. Python's dominant
 * test idiom is to write the assertions once in a helper:
 *
 *     def check_valid_user(user):
 *         assert user.id
 *
 *     def test_creates_user():
 *         check_valid_user(create_user())   # asserts, transitively
 *
 * ## The limit on following calls, and why
 *
 * **At most {@link MAX_HELPER_HOPS} hops, resolved within this file
 * only, and only for calls whose receiver is nothing or `self` / `cls`.**
 *
 * - **Two hops** because the chase saturates there. Measured over the
 *   Python corpus, allowing a third hop credits zero further tests on
 *   both zulip and drf while widening what the detector will forgive.
 * - **Same file only** because there is no repo-wide Python symbol
 *   index to resolve against, and the tempting fallback — matching a
 *   `self.<method>()` against any function of that name anywhere —
 *   guesses at an MRO we have not read. When a helper lives in
 *   `conftest.py` or a base class in another module, this detector
 *   still reports the test. That is a known and accepted miss; it is
 *   the honest one.
 * - **Resolvable receivers only** because `client.check(x)` is a method
 *   on an object whose class we have not read. Crediting it against a
 *   module-level `check` on the trailing segment alone is name
 *   collision, not call following.
 *
 * Each search visits every name at most once and reaches each
 * function's calls by binary search into the line-sorted call list, so
 * the cost is bounded by the calls actually reached rather than by the
 * file's total — deterministic-cheap, per the pack contract.
 *
 * ## Exemptions
 *
 * Benchmarks — `@pytest.mark.benchmark`, or a test declaring the
 * `benchmark` fixture as a parameter — are dropped from both the
 * numerator and the denominator. Asserting on a duration is the thing
 * you should not do, so their silence is correct.
 */
const optionsSchema = z
  .object({
    minAssertionsPerTest: z.number().positive().optional(),
  })
  .strict();

const DEFAULT_MIN_ASSERTIONS_PER_TEST = 1;

/**
 * How far a call chain is followed looking for an assertion.
 *
 * Two hops, same file only. The limit is empirical rather than
 * arbitrary: measured over the Python corpus, a third hop credits
 * exactly zero additional tests on zulip and drf, so the chase
 * saturates at two. It is also the point past which the finding stops
 * being quotable — evidence has to name the helper and the assertion
 * line it stands on, and a four-link chain is a claim a reader cannot
 * check at a glance.
 *
 * Crossing files is deliberately out of scope. It would need a
 * repo-wide Python symbol index that does not exist yet, and the
 * `self.<base-class-method>()` case it would unlock cannot be resolved
 * by name alone without guessing at the MRO. Uncredited is the honest
 * answer there, not credited-on-a-hunch.
 */
const MAX_HELPER_HOPS = 2;

/**
 * Parameter name that requests the `pytest-benchmark` fixture. A test
 * declaring it is a benchmark: the timing harness is the point, and
 * asserting on a duration is exactly what you should not do. This is
 * far more common than the `@pytest.mark.benchmark` decorator — in
 * pydantic's benchmark suites 201 of 203 tests are marked this way and
 * none of them carry the decorator.
 */
const BENCHMARK_FIXTURE = "benchmark";
const BENCHMARK_DECORATOR = /^(pytest\.mark\.)?benchmark\b/;

/**
 * `@pytest.mark.xfail` — the marker *is* the assertion.
 *
 * A test marked xfail asserts that the code under test still fails. The
 * body often has nothing else in it, because there is nothing else to
 * say: pydantic's `test_invalid_json_schema_raises` is one call and a
 * reason string reading "Invalid JSON Schemas are expected to fail."
 * An unexpected pass is reported as XPASS, and under `strict` it fails
 * the run, so the expectation is enforced either way.
 *
 * Unlike a benchmark this stays in the denominator. It is a real test
 * with a real expectation; it just does not write it as an `assert`.
 */
const EXPECTS_FAILURE_DECORATOR = /^(pytest\.mark\.)?xfail\b/;

/** Receivers whose trailing name can be resolved against this file. */
const RESOLVABLE_RECEIVER = /^(self|cls)$/;

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

    // Benchmarks are excluded from the numerator *and* the denominator.
    // A benchmark that asserted on a duration would be a flaky test, so
    // its silence is correct, and leaving it in the denominator would
    // drag the silent share — which drives severity — toward whichever
    // way the benchmark suite happens to be sized.
    //
    // Nested functions are excluded for a different reason: they are not
    // tests at all. See {@link nestedFunctions}.
    const nested = nestedFunctions(ctx.parsed);
    const tests = ctx.parsed.functions.filter(
      (fn) =>
        fn.shape === "test_function" &&
        fn.name !== undefined &&
        /^test/.test(fn.name) &&
        !nested.has(fn) &&
        !isBenchmark(fn),
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
    const direct = tests.filter(
      (fn) => !expectsFailure(fn) && !assertsWithin(ctx.parsed, fn),
    );

    // The line span only reaches assertions written *inside* the test.
    // The dominant Python idiom is to write them once in a shared
    // helper and call it, which the span cannot see. Follow the call
    // graph a bounded distance to find them.
    const helpers = buildHelperIndex(ctx.parsed);
    const silent = direct.filter((fn) => !assertsThroughHelper(ctx.parsed, helpers, fn));
    const creditedViaHelper = direct.length - silent.length;
    if (silent.length === 0) return [];

    const minPerTest = readMinAssertions(ctx.config);
    const totalAssertions = ctx.parsed.assertions.length;
    const ratio = totalAssertions / tests.length;
    const severity = pickSeverity(silent.length, tests.length);

    const shown = silent.slice(0, 8);
    const evidence: string[] = [
      `${silent.length} of ${tests.length} test ${plural(tests.length, "function")} ` +
        `${tests.length === 1 ? "contains" : "contain"} no assertion`,
      ...shown.map(
        (fn) => `\`${fn.name}\` (lines ${fn.startLine}–${fn.endLine}) asserts nothing`,
      ),
      ...(silent.length > shown.length ? [`…+${silent.length - shown.length} more`] : []),
      `${totalAssertions} total ${plural(totalAssertions, "assertion")} across ${tests.length} ` +
        `${plural(tests.length, "test")} (${ratio.toFixed(1)} per test, expected ≥ ${minPerTest})`,
      ...(creditedViaHelper > 0
        ? [
            `${creditedViaHelper} further ${plural(creditedViaHelper, "test")} ` +
              `${creditedViaHelper === 1 ? "asserts" : "assert"} through a same-file ` +
              "helper and are not counted here",
          ]
        : []),
      "counted forms: bare `assert`, unittest `self.assert*` / `self.fail`, " +
        "`pytest.raises`, `pytest.warns`, `@pytest.mark.xfail`, " +
        "`model_dump_json(warnings='error')`, and any of those " +
        `reached through up to ${MAX_HELPER_HOPS} same-file helper calls`,
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

/**
 * Functions declared inside another function's body.
 *
 * `pytest` collects tests at module or class scope only, so a function
 * declared inside another function is not a test however it is named —
 * and neither `unittest` nor `pytest` will ever run it. Counting them
 * invented silent tests wholesale: zulip's `test_message_delete.py`
 * declares four local helpers named `test_delete_message_by_*` inside a
 * single real test, which was 9 of that file's 23 reported survivors,
 * and `test_decorators.py` declares decorated view stubs called
 * `test_view` inside five tests, which was 5 of 71.
 *
 * The boundary is *any* enclosing function, not just an enclosing test.
 * That is where pytest's own collection boundary sits, and the two
 * zulip cases are one of each: a helper inside a test, and a view stub
 * inside a test that only exists to be decorated.
 *
 * Containment is decided on line spans because the parser records no
 * parent link. Sorting by start ascending and end descending puts an
 * enclosing function before everything it encloses, so a single stack
 * sweep decides every function — no pairwise comparison.
 *
 * Note this changes the denominator only. Assertions are still
 * attributed by line span, so an assertion written inside a nested
 * helper continues to credit the test that encloses it.
 */
function nestedFunctions(parsed: ParsedPyFile): Set<ParsedPyFunction> {
  const ordered = [...parsed.functions].sort(
    (a, b) => a.startLine - b.startLine || b.endLine - a.endLine,
  );
  const nested = new Set<ParsedPyFunction>();
  const open: ParsedPyFunction[] = [];
  for (const fn of ordered) {
    while (open.length > 0 && open[open.length - 1]!.endLine < fn.startLine) {
      open.pop();
    }
    if (open.length > 0) nested.add(fn);
    open.push(fn);
  }
  return nested;
}

/**
 * Is this test really a benchmark? Either marker counts — the
 * decorator, or the `benchmark` fixture requested by parameter name.
 */
function isBenchmark(fn: ParsedPyFunction): boolean {
  if (fn.paramNames.includes(BENCHMARK_FIXTURE)) return true;
  return fn.decorators.some((d) => BENCHMARK_DECORATOR.test(d));
}

/** Does this test declare that failure is the expected outcome? */
function expectsFailure(fn: ParsedPyFunction): boolean {
  return fn.decorators.some((d) => EXPECTS_FAILURE_DECORATOR.test(d));
}

/** Does any assertion fall inside this function's line span? */
function assertsWithin(parsed: ParsedPyFile, fn: ParsedPyFunction): boolean {
  return parsed.assertions.some((a) => a.line >= fn.startLine && a.line <= fn.endLine);
}

/**
 * Every named function in the file, keyed by name.
 *
 * A name can map to several functions — two test classes commonly each
 * define their own `setup` or `check` — so the value is a list and a
 * name counts as asserting if *any* function wearing it does. Within a
 * single test file that is the right reading: the question being asked
 * is "is there an assertion behind this name", and answering it per
 * class would need an MRO we do not have.
 */
function buildHelperIndex(parsed: ParsedPyFile): Map<string, ParsedPyFunction[]> {
  const index = new Map<string, ParsedPyFunction[]>();
  for (const fn of parsed.functions) {
    if (fn.name === undefined) continue;
    const existing = index.get(fn.name);
    if (existing) existing.push(fn);
    else index.set(fn.name, [fn]);
  }
  return index;
}

/**
 * Names called from inside `fn` that could refer to something defined
 * in this file.
 *
 * A bare `check(x)` or a `self.check(x)` can. `client.check(x)` cannot:
 * the receiver is some object whose class we have not read, and
 * matching it against a module-level `check` on the trailing segment
 * alone would credit a test for calling something that merely shares a
 * name. That is the difference between following a call and guessing at
 * one.
 */
function resolvableCallNames(parsed: ParsedPyFile, fn: ParsedPyFunction): string[] {
  const names: string[] = [];
  // `parsed.calls` is sorted by line, so seek to the function's first
  // call rather than scanning the file's whole call list once per
  // function — the difference between linear and quadratic on a
  // 6000-line test module.
  for (let i = firstAtOrAfter(parsed, fn.startLine); i < parsed.calls.length; i += 1) {
    const call = parsed.calls[i]!;
    if (call.line > fn.endLine) break;
    if (call.receiver === "" || RESOLVABLE_RECEIVER.test(call.receiver)) {
      names.push(call.name);
    }
  }
  return names;
}

/** Index of the first call at or after `line`, by binary search. */
function firstAtOrAfter(parsed: ParsedPyFile, line: number): number {
  let low = 0;
  let high = parsed.calls.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (parsed.calls[mid]!.line < line) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Breadth-first search over the same-file call graph for an assertion,
 * bounded at `MAX_HELPER_HOPS`.
 *
 * `parsed.calls` is sorted by line, so the per-function slice is a
 * forward scan that stops at the closing line rather than a pass over
 * every call in the file.
 */
function assertsThroughHelper(
  parsed: ParsedPyFile,
  helpers: Map<string, ParsedPyFunction[]>,
  test: ParsedPyFunction,
): boolean {
  const seen = new Set<string>(test.name === undefined ? [] : [test.name]);
  let frontier = resolvableCallNames(parsed, test);

  for (let hop = 0; hop < MAX_HELPER_HOPS; hop += 1) {
    const next: string[] = [];
    for (const name of frontier) {
      if (seen.has(name)) continue;
      seen.add(name);
      const candidates = helpers.get(name);
      if (!candidates) continue;
      for (const candidate of candidates) {
        if (assertsWithin(parsed, candidate)) return true;
        if (hop + 1 < MAX_HELPER_HOPS) {
          next.push(...resolvableCallNames(parsed, candidate));
        }
      }
    }
    if (next.length === 0) return false;
    frontier = next;
  }
  return false;
}

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
