import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding } from "../finding.js";
import type { IaIndex } from "../ia/types.js";
import { intrinsicFrom } from "../scoring/intrinsic.js";

/**
 * Fires when a single destination appears in multiple nav-like source
 * files with conflicting non-empty labels. Updating the label in one nav
 * source while leaving others stale is exactly the cross-file drift that
 * agents repeatedly introduce.
 *
 * The detector emits one finding per drifting destination, anchored on
 * the lexicographically first nav source file declaring that destination.
 * The other nav sources land in `related_files`.
 */
export const duplicatedNavigationSourceDetector: LanguageJsDetector = {
  id: "duplicated_navigation_source",
  name: "Duplicated Navigation Source",
  description:
    "Flags destinations that appear in multiple nav-like source files " +
    "with different labels -- a sign that one nav source is stale.",
  whyItMatters:
    "Multiple files declaring the same destination with different labels " +
    "lead to UI inconsistency that only manifests on the screens nobody " +
    "tests. Updating one source leaves the others stale; eventually the " +
    "team forgets which one is real.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.ia) return [];

    // Each detector emits per-destination, anchored on the
    // lexicographically first nav source file containing the destination.
    // Computing the grouping once is cheap; restricting emission to the
    // anchor file makes the per-file detector loop produce each finding
    // exactly once across the scan.
    const groups = groupByDestination(ctx.ia);

    const findings: Finding[] = [];
    for (const [destination, entries] of groups) {
      if (!shouldEmit(entries)) continue;
      const anchor = entries.map((e) => e.file).sort()[0]!;
      if (anchor !== ctx.file) continue;

      findings.push(buildFinding(destination, entries));
    }
    return findings;
  },
};

interface NavHit {
  file: string;
  label: string;
}

function groupByDestination(ia: IaIndex): Map<string, NavHit[]> {
  const map = new Map<string, NavHit[]>();
  for (const source of ia.navSources) {
    for (const literal of source.entries) {
      for (const entry of literal.entries) {
        if (!entry.destination) continue;
        if (!isInternal(entry.destination)) continue;
        if (!entry.label) continue;

        const key = normalise(entry.destination);
        const list = map.get(key) ?? [];
        list.push({ file: source.file, label: entry.label });
        map.set(key, list);
      }
    }
  }
  return map;
}

function shouldEmit(entries: NavHit[]): boolean {
  // Need at least 2 DIFFERENT files (a file may declare a destination
  // twice; that's its own problem but not this detector's).
  const files = new Set(entries.map((e) => e.file));
  if (files.size < 2) return false;

  // And at least 2 distinct non-empty labels.
  const labels = new Set(entries.map((e) => normaliseLabel(e.label)));
  return labels.size >= 2;
}

function buildFinding(destination: string, entries: NavHit[]): Finding {
  const sortedEntries = [...entries].sort((a, b) => a.file.localeCompare(b.file));
  const distinctLabels = new Set(sortedEntries.map((e) => normaliseLabel(e.label)));
  const anchor = sortedEntries[0]!;

  const evidence: string[] = [`destination: ${destination}`];
  for (const entry of sortedEntries.slice(0, 5)) {
    evidence.push(`${entry.file} label: ${entry.label}`);
  }
  if (sortedEntries.length > 5) {
    evidence.push(`+${sortedEntries.length - 5} more nav source(s)`);
  }

  const related = Array.from(
    new Set(sortedEntries.map((e) => e.file).filter((f) => f !== anchor.file)),
  );

  // Confidence rises with the number of disagreeing labels.
  const confidence = round(Math.min(0.7 + (distinctLabels.size - 2) * 0.05, 0.85));

  return {
    id: "",
    type: "duplicated_navigation_source",
    charge: "Duplicated Navigation Source",
    severity: "medium",
    confidence,
    file: anchor.file,
    summary:
      `Destination ${destination} appears in ${sortedEntries.length} nav source ` +
      `file${sortedEntries.length === 1 ? "" : "s"} with ${distinctLabels.size} ` +
      "different labels. An agent updating one source will leave the others stale.",
    evidence,
    effort: "small",
    fix_shape: "single source of truth for nav; routes derive from it",
    scores: {
      severity: 0.6,
      confidence,
      agent_risk: intrinsicFrom(distinctLabels.size - 1, {
        base: 0.7,
        step: 0.05,
        cap: 0.85,
      }),
    },
    suggested_actions: [
      {
        kind: "consolidate_nav_source",
        description:
          "Move destination metadata into one source of truth or document " +
          "which nav file is canonical.",
        risk: "medium",
      },
    ],
    related_files: related.length > 0 ? related : undefined,
  };
}

function isInternal(dest: string): boolean {
  if (!dest) return false;
  if (dest.startsWith("#")) return false;
  if (/^[a-z]+:\/\//i.test(dest)) return false; // http://, https://, mailto:, tel:
  return dest.startsWith("/");
}

function normalise(dest: string): string {
  return dest.toLowerCase().replace(/\/+$/, "");
}

function normaliseLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
