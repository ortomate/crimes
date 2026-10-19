/**
 * The `language-swift` detector slate: the four structured-surface
 * charges, in Swift's vocabulary. See `../java/index.ts` for why
 * `circular_dependency` and `deep_import` are not ported.
 */

import type { LanguageSwiftDetector } from "../../detector.js";
import { makeDirectDateDetector } from "../structured/direct-date.js";
import { makeLargeFunctionDetector } from "../structured/large-function.js";
import type { LanguageProfile } from "../structured/surface.js";
import { makeSwallowedErrorDetector } from "../structured/swallowed-error.js";
import { makeWeakTestSignalDetector } from "../structured/weak-test-signal.js";

export const SWIFT_PROFILE: LanguageProfile<"language-swift"> = {
  pack: "language-swift",
  suffix: "swift",
  label: "Swift",
  largeFunction: {
    description:
      "Flags Swift functions, initialisers and SwiftUI view bodies that run past a " +
      "shape-appropriate line budget.",
    whyItMatters:
      "A long function is one an agent has to hold entirely in context before it can " +
      "change any part of it safely, and the longer it is the more likely an edit " +
      "breaks a branch nobody re-read. Extracting named private functions — or, for a " +
      "view, subviews — turns an implicit sequence of steps into one the reader can see.",
    extractInto: "named private functions (or subviews, for a view body)",
    budgets: { test_method: 150, constructor: 80, ui_component: 200 },
  },
  swallowedError: {
    description:
      "Flags catch blocks that discard the error, return a bland fallback, or print a " +
      "message without the error itself.",
    whyItMatters:
      "A swallowed error removes the only evidence that something broke. A bare " +
      "`catch { }` catches everything the `do` block can throw, and returning `nil` " +
      "from it turns a failure into a value that looks like absence, so the caller " +
      "handles a missing value rather than a broken operation. `try?` says the same " +
      "thing on purpose and is not reported; a hand-written empty catch usually is not.",
    broadTypes: new Set(["Error", "NSError"]),
    catchAllIsBroad: true,
    deliberateParam: /^(?:ignored?|_)$/,
    failureNoun: "error",
    propagateAdvice:
      'Rethrow, or log the error itself (`logger.error("…: \\(error)")`). If ignoring ' +
      "it is correct, say so with `try?` at the call site instead of an empty catch.",
  },
  directDate: {
    description:
      "Flags Date(), Date.now and NSDate() in domain code that could take the current " +
      "date as a parameter or from an injected clock.",
    whyItMatters:
      "Reading the current date inside domain code makes behaviour depend on when the " +
      "code runs, so a test cannot pin a moment. Bugs at day, month and DST boundaries " +
      "then only appear on a user's device. A `now: Date = Date()` parameter, or an " +
      "injected clock, makes the code deterministic at almost no cost.",
    testabilityNote:
      "each call observes wall time at runtime — a test cannot pin a fixed moment " +
      "without changing the device clock",
    fixShape: "take `now: Date = Date()` as a parameter, or inject a clock",
    injectAdvice:
      "Add a `now: Date = Date()` parameter (or inject a clock) and read the date " +
      "through it, so tests can pass a fixed one.",
    clockBoundary:
      /(?:^|\/)[A-Za-z]*(?:Clock|TimeSource|TimeProvider|DateProvider)\.swift$/,
    propertyCallees: new Set(["Date.now"]),
  },
  weakTestSignal: {
    description:
      "Flags XCTest and Swift Testing files whose tests assert nothing, so they pass as " +
      "long as nothing throws.",
    whyItMatters:
      "A test that runs code without asserting on the result only proves the code did " +
      "not crash. It still turns green and still counts toward coverage, so it reads as " +
      "protection that isn't there. An agent changes the code, sees the suite pass, and " +
      "concludes the change was safe.",
    unitNoun: "function",
    countedForms:
      "`XCTAssert*`, `XCTFail`, `XCTUnwrap`, `#expect`, `#require`, Nimble `expect`",
    strengthenAdvice:
      "Assert on the returned value or the observable side effect with `XCTAssert*` or " +
      "`#expect`. If the test only checks that nothing throws, use `XCTAssertNoThrow` " +
      "so the intent is explicit.",
  },
};

export const largeFunctionSwiftDetector: LanguageSwiftDetector =
  makeLargeFunctionDetector(SWIFT_PROFILE);
export const swallowedErrorSwiftDetector: LanguageSwiftDetector =
  makeSwallowedErrorDetector(SWIFT_PROFILE);
export const directDateSwiftDetector: LanguageSwiftDetector =
  makeDirectDateDetector(SWIFT_PROFILE);
export const weakTestSignalSwiftDetector: LanguageSwiftDetector =
  makeWeakTestSignalDetector(SWIFT_PROFILE);

export const swiftDetectors: LanguageSwiftDetector[] = [
  largeFunctionSwiftDetector,
  swallowedErrorSwiftDetector,
  directDateSwiftDetector,
  weakTestSignalSwiftDetector,
];
