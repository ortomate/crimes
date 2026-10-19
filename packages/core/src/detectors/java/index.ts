/**
 * The `language-java` detector slate.
 *
 * Four detectors, chosen for what a Java codebase most often hides from
 * an agent, each the Java form of a charge the JS and Python packs
 * already make:
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
import { directDateJavaDetector } from "./direct-date.js";
import { largeFunctionJavaDetector } from "./large-function.js";
import { swallowedErrorJavaDetector } from "./swallowed-error.js";
import { weakTestSignalJavaDetector } from "./weak-test-signal.js";

export const javaDetectors: LanguageJavaDetector[] = [
  largeFunctionJavaDetector,
  swallowedErrorJavaDetector,
  directDateJavaDetector,
  weakTestSignalJavaDetector,
];

export {
  directDateJavaDetector,
  largeFunctionJavaDetector,
  swallowedErrorJavaDetector,
  weakTestSignalJavaDetector,
};
