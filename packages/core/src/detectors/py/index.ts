/**
 * The `language-py` detector slate.
 *
 * Eight detectors chosen to **prove the pack seam**, not to reach
 * catalogue parity with the JS side. They deliberately span every kind
 * of evidence a language pack can produce, so that any part of the seam
 * that were still JS-shaped would fail visibly here:
 *
 * | detector                     | evidence source                    |
 * | ---------------------------- | ---------------------------------- |
 * | `large_function.py`          | parsed functions + shape policy    |
 * | `direct_date.py`             | matched call sites                 |
 * | `mixed_utc_local_methods.py` | whole-file call-site correlation   |
 * | `sync_io_in_hotpath.py`      | call sites + enclosing-scope chain |
 * | `boolean_naming_drift.py`    | declarations + initializer shape   |
 * | `weak_test_signal.py`        | test discovery + assertion counts  |
 * | `circular_dependency.py`     | cross-file import graph            |
 * | `deep_import.py`             | import specifiers                  |
 *
 * Further Python detectors can land additively in patch releases
 * without their own minor bump.
 */

import type { LanguagePyDetector } from "../../detector.js";
import { booleanNamingDriftPyDetector } from "./boolean-naming-drift.js";
import { circularDependencyPyDetector } from "./circular-dependency.js";
import { deepImportPyDetector } from "./deep-import.js";
import { directDatePyDetector } from "./direct-date.js";
import { largeFunctionPyDetector } from "./large-function.js";
import { mixedUtcLocalMethodsPyDetector } from "./mixed-utc-local-methods.js";
import { syncIoInHotpathPyDetector } from "./sync-io-in-hotpath.js";
import { weakTestSignalPyDetector } from "./weak-test-signal.js";

export const pythonDetectors: LanguagePyDetector[] = [
  largeFunctionPyDetector,
  directDatePyDetector,
  mixedUtcLocalMethodsPyDetector,
  syncIoInHotpathPyDetector,
  booleanNamingDriftPyDetector,
  weakTestSignalPyDetector,
  circularDependencyPyDetector,
  deepImportPyDetector,
];

export {
  booleanNamingDriftPyDetector,
  circularDependencyPyDetector,
  deepImportPyDetector,
  directDatePyDetector,
  largeFunctionPyDetector,
  mixedUtcLocalMethodsPyDetector,
  syncIoInHotpathPyDetector,
  weakTestSignalPyDetector,
};
