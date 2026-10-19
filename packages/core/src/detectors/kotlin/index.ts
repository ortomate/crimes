/**
 * The `language-kotlin` detector slate: the four structured-surface
 * charges the Java pack makes, in Kotlin's vocabulary. See
 * `../java/index.ts` for why `circular_dependency` and `deep_import` are
 * not ported.
 */

import type { LanguageKotlinDetector } from "../../detector.js";
import { makeDirectDateDetector } from "../structured/direct-date.js";
import { makeLargeFunctionDetector } from "../structured/large-function.js";
import type { LanguageProfile } from "../structured/surface.js";
import { makeSwallowedErrorDetector } from "../structured/swallowed-error.js";
import { makeWeakTestSignalDetector } from "../structured/weak-test-signal.js";

export const KOTLIN_PROFILE: LanguageProfile<"language-kotlin"> = {
  pack: "language-kotlin",
  suffix: "kt",
  label: "Kotlin",
  largeFunction: {
    description:
      "Flags Kotlin functions, constructors and init blocks that run past a " +
      "shape-appropriate line budget.",
    whyItMatters:
      "A long function is one an agent has to hold entirely in context before it can " +
      "change any part of it safely, and the longer it is the more likely an edit " +
      "breaks a branch nobody re-read. Extracting named private functions turns an " +
      "implicit sequence of steps into one the reader — and the next agent — can see.",
    extractInto: "named private functions",
    budgets: { test_method: 150, constructor: 80, ui_component: 200 },
  },
  swallowedError: {
    description:
      "Flags catch blocks that discard the exception, return a bland fallback, or log " +
      "a message without the exception itself.",
    whyItMatters:
      "A swallowed exception removes the only evidence that something broke. Kotlin has " +
      "no checked exceptions, so a `catch` is always a choice — and `try { … } catch " +
      "(e: Exception) { null }` is the shortest way to turn a failure into a value that " +
      "looks like absence. An agent reading the call site sees a nullable result and " +
      "handles a missing value, not a broken operation.",
    broadTypes: new Set(["Exception", "Throwable", "RuntimeException", "Error"]),
    catchAllIsBroad: false,
    deliberateParam: /^(?:ignored?\d*|expected|unused|_+)$/,
    failureNoun: "exception",
    propagateAdvice:
      "Rethrow, or log the exception itself (`Log.e(TAG, msg, e)`, `Timber.e(e, msg)`). " +
      "If ignoring it is correct, name the parameter `ignored` and say why.",
  },
  directDate: {
    description:
      "Flags System.currentTimeMillis(), Date(), Instant.now(), Clock.System.now() and " +
      "other wall-clock reads in domain code that could take an injected clock.",
    whyItMatters:
      "Reading the system clock inside domain code makes behaviour depend on when the " +
      "code runs, so a test either cannot pin a moment or has to mock a static call. " +
      "Bugs at day, month and DST boundaries then only appear in production. Passing a " +
      "clock in (`java.time.Clock`, or kotlinx-datetime's `Clock`) makes the code " +
      "deterministic.",
    testabilityNote:
      "each call observes wall time at runtime — a test cannot pin a fixed moment " +
      "without mocking a static call",
    fixShape: "inject a Clock; read time through it",
    injectAdvice:
      "Take a `Clock` as a constructor parameter (`java.time.Clock`, or " +
      "`kotlinx.datetime.Clock`) and read time through it, so tests can pass a fixed one.",
    clockBoundary: /(?:^|\/)[A-Za-z]*(?:Clock|TimeSource|TimeProvider|DateUtils?)\.kts?$/,
  },
  weakTestSignal: {
    description:
      "Flags JUnit / kotlin.test files whose test functions assert nothing, so they pass " +
      "as long as nothing throws.",
    whyItMatters:
      "A test that runs code without asserting on the result only proves the code did " +
      "not throw. It still turns green and still counts toward coverage, so it reads as " +
      "protection that isn't there. An agent changes the code, sees the suite pass, and " +
      "concludes the change was safe.",
    unitNoun: "function",
    countedForms:
      "`assert*`, `fail`, `verify*` (Mockito, MockK), `expect*`, `andExpect`, Kotest " +
      "`should*` matchers, `@Test(expected = …)`",
    strengthenAdvice:
      "Assert on the returned value or the observable side effect. If the test only " +
      "checks that nothing throws, use `assertDoesNotThrow` so the intent is explicit.",
  },
};

export const largeFunctionKotlinDetector: LanguageKotlinDetector =
  makeLargeFunctionDetector(KOTLIN_PROFILE);
export const swallowedErrorKotlinDetector: LanguageKotlinDetector =
  makeSwallowedErrorDetector(KOTLIN_PROFILE);
export const directDateKotlinDetector: LanguageKotlinDetector =
  makeDirectDateDetector(KOTLIN_PROFILE);
export const weakTestSignalKotlinDetector: LanguageKotlinDetector =
  makeWeakTestSignalDetector(KOTLIN_PROFILE);

export const kotlinDetectors: LanguageKotlinDetector[] = [
  largeFunctionKotlinDetector,
  swallowedErrorKotlinDetector,
  directDateKotlinDetector,
  weakTestSignalKotlinDetector,
];
