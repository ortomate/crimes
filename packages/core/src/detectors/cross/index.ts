/**
 * The `cross-language` detector slate (0.15.0).
 *
 * These are the findings no single-language tool can produce: each one
 * is a disagreement *between* two languages about the same thing, which
 * neither language's type checker, linter, or compiler can see.
 *
 * | detector                             | the disagreement                    |
 * | ------------------------------------ | ----------------------------------- |
 * | `cross_language_route_drift`          | frontend calls a path the backend doesn't serve |
 * | `cross_language_type_drift`           | a closed set listed differently on each side    |
 * | `cross_language_concept_alias_drift`  | the same concept named differently per language |
 *
 * All three follow the 0.3.0 IA family's discipline, with extra force
 * because the false-positive surface is roughly squared across two
 * languages:
 *
 *  - **Never fire one-sided.** Each returns early unless both languages
 *    are present with the relevant evidence. "No backend route" for
 *    every fetch in a JS-only repo would be noise proportional to the
 *    repo's size.
 *  - **Only quotable evidence.** A runtime-assembled path or a union
 *    with a non-literal member is skipped rather than half-recorded.
 *  - **Require real overlap before claiming drift.** Two unrelated
 *    `Status` types that share a name and nothing else are different
 *    concepts, not a disagreement.
 */

import type { CrossLanguageDetector } from "../../detector.js";
import { crossLanguageConceptAliasDriftDetector } from "./alias-drift.js";
import { crossLanguageRouteDriftDetector } from "./route-drift.js";
import { crossLanguageTypeDriftDetector } from "./type-drift.js";

export const crossLanguageDetectors: CrossLanguageDetector[] = [
  crossLanguageRouteDriftDetector,
  crossLanguageTypeDriftDetector,
  crossLanguageConceptAliasDriftDetector,
];

export {
  crossLanguageConceptAliasDriftDetector,
  crossLanguageRouteDriftDetector,
  crossLanguageTypeDriftDetector,
};
