import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import { buildFinding } from "./exact-duplicate-block.js";

/**
 * Fires when a function body shares the same shape hash (identifier
 * names normalised to positional placeholders) across ≥2 files. This
 * catches copy-pasted functions where the author renamed local
 * variables but kept the structure.
 *
 * Anchored on the lex-first file in each duplicate set; lower
 * confidence than `exact_duplicate_block` because shape hashes collide
 * more easily on smaller bodies — the index builder enforces a ≥40
 * token floor to keep collisions in check.
 */
export const nearDuplicateBlockDetector: LanguageJsDetector = {
  id: "near_duplicate_block",
  name: "Near-Duplicate Block",
  description:
    "Flags function bodies with the same structural shape across two " +
    "or more files (copy-pasted, then renamed).",
  whyItMatters:
    "Near-duplicate function bodies indicate that someone copied a " +
    "function and renamed the variables. The same maintenance penalty " +
    "as exact duplication, but harder for reviewers to spot — the bodies " +
    "look superficially different, only the shape is identical.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.functionHashIndex) return [];
    const findings: Finding[] = [];
    for (const [hash, hits] of ctx.functionHashIndex.byShape) {
      const distinctFiles = new Set(hits.map((h) => h.file));
      if (distinctFiles.size < 2) continue;
      // Avoid double-reporting: if every site in this shape group also
      // shares an exact hash, the `exact_duplicate_block` detector already
      // fired. Skip silently to keep the two detectors from echoing each
      // other on the same evidence.
      const exactGroup = ctx.functionHashIndex.byExact;
      const exactKey = anyExactKeyShared(hits, exactGroup);
      if (exactKey !== undefined) continue;

      const anchor = [...distinctFiles].sort()[0]!;
      if (anchor !== ctx.file) continue;
      findings.push(
        buildFinding({
          type: "near_duplicate_block",
          charge: "Near-Duplicate Block",
          severityFloor: "medium",
          confidence: 0.85,
          hash,
          hits,
          anchor,
          fixShape: "consolidate into one helper; pass the differing values as args",
        }),
      );
    }
    return findings;
  },
};

/**
 * Best-effort overlap check: return the exact-hash key of any function
 * in `hits` that already groups with another function in `exactGroup`.
 * If we find one, the shape match is structurally identical to (or a
 * subset of) the exact match — defer to the exact detector.
 */
function anyExactKeyShared(
  hits: import("../ast-hash/function-index.js").FunctionHit[],
  exactGroup: Map<string, import("../ast-hash/function-index.js").FunctionHit[]>,
): string | undefined {
  for (const [exactHash, exactHits] of exactGroup) {
    if (exactHits.length < 2) continue;
    const exactFiles = new Set(exactHits.map((h) => h.file));
    let overlapping = 0;
    for (const h of hits) {
      if (exactFiles.has(h.file)) overlapping += 1;
    }
    if (overlapping >= 2) return exactHash;
  }
  return undefined;
}
