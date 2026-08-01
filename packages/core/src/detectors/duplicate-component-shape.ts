import type { LanguageJsDetector, DetectorContext } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type { JsxShapeHit } from "../jsx/shape-index.js";

/**
 * Fires when the same JSX subtree shape appears in ≥3 distinct files.
 * Uses the repo-wide shape index built once per scan; the per-file
 * detector loop emits each finding exactly once by anchoring on the
 * lex-first file in the duplicate set.
 *
 * "Shape" is the structural hash from `ast-hash/hash.ts` — local
 * identifier names are normalised to positional placeholders, so
 * `<Card name={a}/>` and `<Card name={b}/>` collide on shape but
 * different element trees do not.
 */
export const duplicateComponentShapeDetector: LanguageJsDetector = {
  id: "duplicate_component_shape",
  name: "Duplicate Component Shape",
  description:
    "Flags JSX subtrees that appear in three or more files with the " +
    "same structural shape — usually a sign that a shared component " +
    "should have been extracted.",
  whyItMatters:
    "Three copies of the same JSX shape mean three places to keep in " +
    "sync. Every visual tweak now has to land three times, every " +
    "accessibility fix the same. Agents extending one copy quietly " +
    "drift the others further apart.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.jsxShapeIndex) return [];

    const findings: Finding[] = [];
    for (const [shape, sites] of ctx.jsxShapeIndex.byShape) {
      const distinctFiles = new Set(sites.map((s) => s.file));
      if (distinctFiles.size < 3) continue;
      const anchor = [...distinctFiles].sort()[0]!;
      if (anchor !== ctx.file) continue;
      findings.push(buildFinding(shape, sites, anchor));
    }
    return findings;
  },
};

function buildFinding(shape: string, sites: JsxShapeHit[], anchor: string): Finding {
  const sortedSites = [...sites].sort((a, b) =>
    a.file === b.file ? a.lines[0] - b.lines[0] : a.file.localeCompare(b.file),
  );
  const distinctFiles = Array.from(new Set(sortedSites.map((s) => s.file))).sort();
  const rootName = mostCommonRootName(sortedSites);

  const evidence: string[] = [
    `shape: <${rootName}> subtree, hash ${shape.slice(0, 12)}…`,
    `${distinctFiles.length} file(s), ${sortedSites.length} occurrence(s)`,
  ];
  for (const site of sortedSites.slice(0, 5)) {
    evidence.push(`${site.file}:${site.lines[0]}-${site.lines[1]}: <${site.rootName}>`);
  }
  if (sortedSites.length > 5) {
    evidence.push(`+${sortedSites.length - 5} more occurrence(s)`);
  }

  return {
    id: "",
    type: "duplicate_component_shape",
    charge: "Duplicate Component Shape",
    severity: "medium",
    confidence: 0.7,
    file: anchor,
    summary:
      `${rootName} subtree appears in ${distinctFiles.length} files with the ` +
      "same structural shape. Extracting a shared component would let edits " +
      "land in one place instead of being repeated by hand.",
    evidence,
    effort: "small",
    fix_shape: "extract the shared component; parameterise the differing props",
    scores: {
      severity: 0.55,
      confidence: 0.7,
    },
    suggested_actions: [
      {
        kind: "extract_shared_component",
        description:
          "Promote the repeated subtree into a shared component so styling, " +
          "accessibility, and behaviour fixes land once.",
        risk: "medium",
      },
    ],
    related_files: distinctFiles.filter((f) => f !== anchor),
  };
}

function mostCommonRootName(sites: JsxShapeHit[]): string {
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.rootName, (counts.get(s.rootName) ?? 0) + 1);
  let best = sites[0]!.rootName;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

// Reserved for callers that want to filter the shape index further
// before computing duplicates.
export type { DetectorContext };
