/**
 * The `language-java` detector slate.
 *
 * Four detectors, each the Java form of a charge the JS and Python packs
 * already make, built from the shared structured-surface factories in
 * `../structured/` and configured by {@link JAVA_PROFILE}:
 *
 * | detector                 | evidence source                     |
 * | ------------------------ | ----------------------------------- |
 * | `large_function.java`    | parsed methods + shape policy       |
 * | `swallowed_error.java`   | catch clauses and what they do      |
 * | `direct_date.java`       | wall-clock call sites               |
 * | `weak_test_signal.java`  | test methods + assertion counts     |
 *
 * Not yet ported, deliberately: `circular_dependency` (bidirectional
 * entity references make file-level cycles routine in Java, so it needs
 * a package-level design first) and `deep_import` (deep package paths
 * are the language's convention, not a smell).
 */

import type { LanguageJavaDetector } from "../../detector.js";
import { makeDirectDateDetector } from "../structured/direct-date.js";
import { makeLargeFunctionDetector } from "../structured/large-function.js";
import type { LanguageProfile } from "../structured/surface.js";
import { makeSwallowedErrorDetector } from "../structured/swallowed-error.js";
import { makeWeakTestSignalDetector } from "../structured/weak-test-signal.js";

export const JAVA_PROFILE: LanguageProfile<"language-java"> = {
  pack: "language-java",
  suffix: "java",
  label: "Java",
  largeFunction: {
    description:
      "Flags Java methods and constructors that run past a shape-appropriate line budget.",
    whyItMatters:
      "A long method is one an agent has to hold entirely in context before it can " +
      "change any part of it safely, and the longer it is the more likely an edit " +
      "breaks a branch nobody re-read. Extracting named private methods turns an " +
      "implicit sequence of steps into one the reader — and the next agent — can see.",
    extractInto: "named private methods",
    budgets: { test_method: 150, constructor: 80 },
  },
  swallowedError: {
    description:
      "Flags catch blocks that discard the exception, return a bland fallback, or log " +
      "a message without the exception itself.",
    whyItMatters:
      "A swallowed exception removes the only evidence that something broke. The " +
      "write did not land and the method returned as if it had; the bug surfaces later " +
      "with no stack trace to follow. Java's checked exceptions make this the path of " +
      "least resistance — an empty catch is what makes the compiler stop complaining — " +
      "and for an agent an empty catch reads as handled, so it builds on a guarantee " +
      "that was never there.",
    broadTypes: new Set(["Exception", "Throwable", "RuntimeException", "Error"]),
    catchAllIsBroad: false,
    // `ignored` is the name IntelliJ suggests for exactly this, and
    // `expected` the JUnit 4 idiom for an exception a test provokes.
    deliberateParam: /^(?:ignored?|expected|unused|_+)$/,
    failureNoun: "exception",
    propagateAdvice:
      "Rethrow (wrapped if the signature requires it), or log the exception " +
      "itself. If ignoring it is correct, name the parameter `ignored` and say why.",
  },
  directDate: {
    description:
      "Flags System.currentTimeMillis(), new Date(), Instant.now() and other wall-clock " +
      "reads in domain code that could take an injected java.time.Clock.",
    whyItMatters:
      "Reading the system clock inside domain code makes behaviour depend on when the " +
      "code runs, so a test either cannot pin a moment or has to mock static methods. " +
      "Bugs at day, month and DST boundaries then only appear in production. Passing a " +
      "`Clock` in makes the code deterministic and puts the time-zone decision in one place.",
    testabilityNote:
      "each call observes wall time at runtime — a test cannot pin a fixed moment " +
      "without mocking a static method",
    fixShape: "inject a java.time.Clock; read time through it",
    injectAdvice:
      "Take a `java.time.Clock` in the constructor and call `Instant.now(clock)` " +
      "/ `clock.millis()`, so tests can pass `Clock.fixed(...)`.",
    clockBoundary: /(?:^|\/)[A-Za-z]*(?:Clock|TimeSource|TimeProvider|DateUtils?)\.java$/,
  },
  weakTestSignal: {
    description:
      "Flags JUnit / TestNG files whose test methods assert nothing, so they pass as " +
      "long as nothing throws.",
    whyItMatters:
      "A test that runs code without asserting on the result only proves the code did " +
      "not throw. It still turns green and still counts toward coverage, so it reads as " +
      "protection that isn't there. An agent changes the code, sees the suite pass, and " +
      "concludes the change was safe.",
    unitNoun: "method",
    countedForms:
      "`assert*`, `fail`, `verify*`, `expect*`, `andExpect`, the " +
      "`assert` statement, `@Test(expected = …)`",
    strengthenAdvice:
      "Assert on the returned value or the observable side effect. If the test " +
      "only checks that nothing throws, use `assertDoesNotThrow` so the intent " +
      "is explicit.",
  },
};

export const largeFunctionJavaDetector: LanguageJavaDetector =
  makeLargeFunctionDetector(JAVA_PROFILE);
export const swallowedErrorJavaDetector: LanguageJavaDetector =
  makeSwallowedErrorDetector(JAVA_PROFILE);
export const directDateJavaDetector: LanguageJavaDetector =
  makeDirectDateDetector(JAVA_PROFILE);
export const weakTestSignalJavaDetector: LanguageJavaDetector =
  makeWeakTestSignalDetector(JAVA_PROFILE);

export const javaDetectors: LanguageJavaDetector[] = [
  largeFunctionJavaDetector,
  swallowedErrorJavaDetector,
  directDateJavaDetector,
  weakTestSignalJavaDetector,
];
