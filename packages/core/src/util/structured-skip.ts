import { generatedMatcherFor } from "../manifest/gitattributes.js";
import { isNeverReportable } from "./scope-class.js";

/**
 * Should the Java, Kotlin and Swift packs skip parsing this file?
 *
 * True for files whose findings are never reported anyway: generated or
 * vendored by path or banner (`isNeverReportable`), or declared
 * `linguist-generated` in `.gitattributes`. Skipping them is not a
 * coverage gap — nothing in them could reach a report — but parsing them
 * was the largest cost these packs had. On a private iOS app the generated
 * OpenAPI client (`API/src/**`, files up to 240 KB) took the Swift
 * grammar's WASM heap past 1.5 GB, and a WASM heap never shrinks.
 *
 * Their edges are lost with them, which only affects the blast radius of
 * generated files themselves: they have no findings for it to rank.
 *
 * Built once per analysis; `.gitattributes` is read once.
 */
export function structuredSkipFor(root: string): (repoPath: string) => boolean {
  const generated = generatedMatcherFor(root);
  return (repoPath) => isNeverReportable(repoPath) || generated(repoPath);
}
