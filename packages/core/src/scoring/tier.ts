import { matchLayerPattern } from "../detectors/layer-violation.js";

export type Tier = "domain" | "nonDomain";

/**
 * Expand a single glob pattern that may contain one `{a,b,c}` brace group
 * into an array of concrete patterns. Only the first brace group is expanded
 * (sufficient for the DEFAULT_NON_DOMAIN_PATTERNS). Returns `[pattern]` as-is
 * if no braces are present.
 *
 * Example: `"**\/*.test.{ts,tsx}"` → `["**\/*.test.ts", "**\/*.test.tsx"]`
 */
function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start === -1) return [pattern];
  const end = pattern.indexOf("}", start);
  if (end === -1) return [pattern];
  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  const alternatives = pattern.slice(start + 1, end).split(",");
  return alternatives.map((alt) => `${prefix}${alt}${suffix}`);
}

/**
 * Expand all brace groups in a list of glob patterns, returning a flat list
 * of concrete patterns that matchLayerPattern can handle.
 */
function expandAllBraces(patterns: string[]): string[] {
  return patterns.flatMap(expandBraces);
}

/**
 * Classify a single repo-relative POSIX path against the non-domain
 * patterns. O(P) per call where P = pattern count. Use makeTierClassifier
 * for repeated lookups.
 */
export function classifyTier(repoRelPath: string, nonDomainPatterns: string[]): Tier {
  if (nonDomainPatterns.length === 0) return "domain";
  const expanded = expandAllBraces(nonDomainPatterns);
  for (const pattern of expanded) {
    if (matchLayerPattern(pattern, repoRelPath)) return "nonDomain";
  }
  return "domain";
}

/**
 * Compile the patterns once and return a memoised classifier. Use this
 * when classifying many files in a single scan.
 */
export function makeTierClassifier(
  nonDomainPatterns: string[],
): (repoRelPath: string) => Tier {
  if (nonDomainPatterns.length === 0) return () => "domain";
  const expanded = expandAllBraces(nonDomainPatterns);
  const cache = new Map<string, Tier>();
  return (path: string): Tier => {
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    const result: Tier = expanded.some((p) => matchLayerPattern(p, path))
      ? "nonDomain"
      : "domain";
    cache.set(path, result);
    return result;
  };
}
