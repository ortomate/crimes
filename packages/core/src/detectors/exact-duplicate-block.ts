import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type { FunctionHit } from "../ast-hash/function-index.js";
import { anchoredGroups } from "./duplicate-anchor-index.js";

/**
 * Fires when a function body is verbatim-identical (modulo whitespace
 * and comments) across ≥2 files. Anchored on the lex-first file in the
 * duplicate set so the per-file detector loop emits each finding
 * exactly once.
 *
 * Token and line thresholds in the index builder exclude trivial
 * helpers — three duplicate one-liners is noise, three duplicate
 * 30-line bodies is signal.
 */
export const exactDuplicateBlockDetector: LanguageJsDetector = {
  id: "exact_duplicate_block",
  name: "Exact Duplicate Block",
  description:
    "Flags function bodies that are verbatim-identical across two or " + "more files.",
  whyItMatters:
    "Two copies of the same function body mean two places to keep in " +
    "sync. Every fix has to land twice, every refactor too. Reviewers " +
    "can't tell which one is the source of truth, and the next agent " +
    "edits one and forgets the other.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.functionHashIndex) return [];
    const findings: Finding[] = [];
    // Groups anchored on this file, ordered by hash. The sort happens
    // once per index rather than once per file — see
    // duplicate-anchor-index.ts for why that mattered.
    const groups = anchoredGroups(ctx.functionHashIndex, "exact").get(ctx.file) ?? [];
    for (const { hash, hits, anchor } of groups) {
      findings.push(
        buildFinding({
          type: "exact_duplicate_block",
          charge: "Exact Duplicate Block",
          severityFloor: "medium",
          confidence: 0.95,
          hash,
          hits,
          anchor,
          fixShape: "extract the duplicated block into a shared helper",
        }),
      );
    }
    return findings;
  },
};

export function buildFinding(args: {
  type: string;
  charge: string;
  severityFloor: "medium";
  confidence: number;
  hash: string;
  hits: FunctionHit[];
  anchor: string;
  /**
   * Per-call fix_shape phrasing. Required so each caller (exact vs
   * near-duplicate detectors) carries the right detector-defaults entry
   * onto the emitted finding.
   */
  fixShape: string;
}): Finding {
  const sortedSites = [...args.hits].sort((a, b) =>
    a.file === b.file ? a.lines[0] - b.lines[0] : a.file.localeCompare(b.file),
  );
  const distinctFiles = Array.from(new Set(sortedSites.map((s) => s.file))).sort();

  const evidence: string[] = [
    `hash ${args.hash.slice(0, 12)}… across ${distinctFiles.length} file(s), ` +
      `${sortedSites.length} occurrence(s)`,
  ];
  for (const site of sortedSites.slice(0, 5)) {
    const sym = site.symbol ? ` (${site.symbol})` : "";
    evidence.push(`${site.file}:${site.lines[0]}-${site.lines[1]}${sym}`);
  }
  if (sortedSites.length > 5) {
    evidence.push(`+${sortedSites.length - 5} more occurrence(s)`);
  }

  return {
    id: "",
    type: args.type,
    charge: args.charge,
    severity: "medium",
    confidence: args.confidence,
    file: args.anchor,
    // One anchor file can be the lex-first member of several distinct
    // duplicate groups, and these findings carry no `symbol`. The body
    // hash is what separates the groups and is stable across scans of
    // the same code, so it is the discriminator. Truncated to match the
    // evidence line a reader sees.
    discriminator: args.hash.slice(0, 12),
    summary:
      `Function appears in ${distinctFiles.length} files with the same body. ` +
      "Each fix has to land in every copy; extracting a shared helper would " +
      "make the duplication explicit.",
    evidence,
    effort: "small",
    fix_shape: args.fixShape,
    scores: {
      severity: 0.55,
      confidence: args.confidence,
    },
    suggested_actions: [
      {
        kind: "extract_shared_helper",
        description:
          "Promote the duplicated body into a shared helper module so " +
          "future edits land once.",
        risk: "medium",
      },
    ],
    related_files: distinctFiles.filter((f) => f !== args.anchor),
  };
}
