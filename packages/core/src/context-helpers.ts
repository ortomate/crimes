import { findingRankScore } from "./scoring/ranking.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ContextRelatedFile } from "./context-related-files.js";
import type { CrimesConfig } from "./config.js";
import type { Finding, Severity } from "./finding.js";
import type { ContextRisk } from "./context.js";
import { makeTierClassifier } from "./scoring/tier.js";
import { fingerprintFinding } from "./fingerprint.js";

/**
 * Per-finding-type guidance shown to agents in the human report and in
 * `agent_guidance`. Keep short and behavioural — not "fix this", but
 * "don't make it worse" before the agent edits.
 */
const GUIDANCE: Record<string, string> = {
  duplicated_policy:
    "Read every related policy implementation before changing one side; preserve their shared contract.",
  contract_drift:
    "Compare the related contract declarations and their consumers before editing either representation.",
  config_drift:
    "Check the documented variable names and source defaults together; do not inspect real environment values.",
  pass_through_abstraction:
    "Follow the forwarding chain to the implementation that owns this behaviour before editing.",
  swallowed_error:
    "Check the protected operation and recovery contract before relying on this fallback.",
  sync_io_in_hotpath:
    "Inspect callers and error propagation before converting blocking I/O to async.",
  agent_permission_sprawl:
    "Review committed agent permissions as text; do not execute discovered hooks or commands.",
  dependency_provenance_gap:
    "Compare imports with the repository's manifests and lockfile before changing dependencies.",
  large_function: "Prefer extracting pure helpers before adding more branches.",
  large_file: "Read the whole file before editing — propose splits in their own change.",
  direct_date: "Avoid adding more direct clock access; inject time where possible.",
  todo_density: "Review TODOs before relying on comments as current intent.",
  commented_out_code:
    "Do not copy disabled code from comments; verify whether it should be deleted or explained as rationale.",
  logic_in_comments:
    "Treat prose-only rules as suspect; encode them in guards, tests, config, or types before relying on them.",
  name_behavior_mismatch:
    "Safe-sounding names may hide side effects — inspect callers before moving, caching, or duplicating them.",
  magic_domain_literal_scatter:
    "Inspect related consumers and preserve intentional policy variants. Reuse existing authority when available; keep consolidation separate unless the requested change needs it.",
  weak_test_signal:
    "Nearby tests may not protect behaviour; inspect assertions before treating them as safety coverage.",
  option_bag_junk_drawer:
    "Generic object bags hide required shape — identify the actual fields before adding or renaming properties.",
  return_shape_roulette:
    "This function returns multiple object shapes; check every caller before depending on one result shape.",
  negative_flag_maze:
    "Multiple negative flags make predicates easy to invert — simplify or name the predicate before extending it.",
  missing_agent_context:
    "Agents may miss project-specific commands, architecture rules, and safety checks.",
  route_metadata_drift:
    "The route path, title, breadcrumb, and component name appear to disagree — verify each before changing labels.",
  duplicated_navigation_source:
    "Multiple files declare this destination; updating only one will leave the others stale.",
  concept_alias_drift:
    "Other files describe this concept under a different name; read them before renaming or extending.",
  docs_code_drift:
    "Docs reference local files that no longer exist — update the docs in the same PR.",
};

/**
 * Guidance line emitted when a file has no findings but does have
 * deterministic related files. Keeps the "Agent guidance" block
 * non-empty in the common neighbourhood-only case (an agent landed on a
 * clean route file, but other files clearly share its domain).
 */
const NEIGHBOURHOOD_GUIDANCE =
  "Review related files before editing — they share domain tokens or route/navigation evidence with this target.";

export function buildRisk(findings: Finding[]): ContextRisk {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  let level: ContextRisk["level"] = "none";
  if (counts.high > 0) level = "high";
  else if (counts.medium > 0) level = "medium";
  else if (counts.low > 0) level = "low";
  return {
    level,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    total: findings.length,
  };
}

export function buildGuidance(
  findings: Finding[],
  relatedFiles: ContextRelatedFile[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of findings) {
    if (seen.has(f.type)) continue;
    seen.add(f.type);
    const line = GUIDANCE[f.type];
    if (line) out.push(line);
  }
  // Add the neighbourhood line only when nothing else fired — when a
  // finding-keyed guidance line is already present, the IA wording
  // ("read them before renaming or extending", etc.) already covers
  // related files. Adding both would dilute the more specific line.
  if (out.length === 0 && relatedFiles.length > 0) {
    out.push(NEIGHBOURHOOD_GUIDANCE);
  }
  return out;
}

export function toRepoRelative(root: string, file: string): string {
  const abs = isAbsolute(file) ? file : resolve(root, file);
  return toRepoPath(relative(root, abs));
}

export function toRepoPath(p: string): string {
  return p.split(sep).join("/");
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * Secondary (tiebreaker) comparator used by tagTierAndSortByRankScore.
 * Matches the historical scan.ts ordering: severity desc → confidence
 * desc → file asc → line-start asc.
 */
function existingSecondarySort(a: Finding, b: Finding): number {
  const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (sev !== 0) return sev;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  const lineDelta = (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0);
  if (lineDelta !== 0) return lineDelta;
  // Final, total key. Everything above can tie — `lines` is absent on
  // 12-16% of findings, so two file-level findings both fall back to 0 —
  // and `Array.prototype.sort` then preserves whatever order the
  // detectors happened to emit, which follows filesystem iteration.
  // That made `crime_NNNNN` ids depend on directory listing order.
  // Fingerprints are unique as of 0.17.2, so this makes the comparator
  // total rather than merely longer.
  return fingerprintFinding(a).localeCompare(fingerprintFinding(b));
}

/**
 * Tag every finding with `tier` from config.scopeTiers.nonDomain and sort
 * by rank_score = agent_risk * (1 + recency * 0.5) desc.
 *
 * Tiebreaker falls back to existingSecondarySort (severity desc, confidence
 * desc, file asc, lines start asc) to preserve stable secondary ordering.
 *
 * rank_score is intentionally NOT stored on the finding — it's ephemeral
 * and not part of the JSON contract.
 *
 * @param options.recencyEnabled When false, the recency multiplier collapses
 *   to 1 so findings sort by agent_risk alone. Default true.
 */
export function tagTierAndSortByRankScore(
  findings: Finding[],
  config: CrimesConfig,
  options: { recencyEnabled?: boolean } = {},
): void {
  const recencyEnabled = options.recencyEnabled ?? true;
  const nonDomain = config.scopeTiers?.nonDomain ?? [];
  const classify = makeTierClassifier(nonDomain);
  for (const f of findings) {
    f.tier = classify(f.file);
  }
  findings.sort((a, b) => {
    const ra = findingRankScore(a, recencyEnabled);
    const rb = findingRankScore(b, recencyEnabled);
    if (rb !== ra) return rb - ra;
    return existingSecondarySort(a, b);
  });
}

/**
 * Stamp both handles a consumer can hold a finding by.
 *
 * `id` is positional and only means anything within the report that
 * produced it. `fingerprint` is the stable one — it survives across
 * scans and is what `crimes ignore` / `unignore` / `feedback` / `triage`
 * accept. Both are assigned here, after sorting, because this is the one
 * point every report shape passes through.
 */
export function assignIdsAndFingerprints(findings: Finding[]): void {
  findings.forEach((f, i) => {
    f.id = `crime_${String(i + 1).padStart(5, "0")}`;
    f.fingerprint = fingerprintFinding(f);
  });
}
