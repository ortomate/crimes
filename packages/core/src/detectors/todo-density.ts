import type { UniversalDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";

const TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b/g;

// Narrow self-reference exemption: a file that itself contains the literal
// regex token sequence `TODO|FIXME|XXX|HACK` is the detector source (or a
// fixture/test thereof) and would otherwise flag itself every scan. Matches
// both `/\b(TODO|FIXME|XXX|HACK)\b/` and `"TODO|FIXME|XXX|HACK"` shapes; does
// NOT match prose that merely mentions one marker name in passing.
const SELF_REFERENCE_PATTERN = /TODO\s*\|\s*FIXME\s*\|\s*XXX\s*\|\s*HACK/;

export const todoDensityDetector: UniversalDetector = {
  id: "todo_density",
  name: "TODO/FIXME Density",
  description:
    "Flags files with a high concentration of TODO, FIXME, XXX, or HACK markers.",
  whyItMatters:
    "A high density of TODO/FIXME comments tells readers the code does " +
    "not match its intent. Agents tend to act on visible code without " +
    "weighing the unbuilt promises around it, and reviewers skim past " +
    "warnings that have become wallpaper.",

  pack: "universal",
  async run(ctx) {
    // Skip files that *define* the marker set rather than carry markers.
    const source = await ctx.readSource();
    if (SELF_REFERENCE_PATTERN.test(source)) return [];

    const matches = [...source.matchAll(TODO_PATTERN)];
    if (matches.length === 0) return [];

    const lines = ctx.lineCount;
    const kloc = Math.max(lines / 1000, 0.001);
    const density = matches.length / kloc;
    const threshold = ctx.config.thresholds.todoDensityPerKLoc;

    // Floor: at least 3 markers OR density above the configured threshold before
    // we even surface this. A lone TODO is noise.
    if (matches.length < 3 && density < threshold) return [];

    const ratio = density / threshold;
    const severity = pickSeverity(matches.length, ratio);
    const breakdown = countByMarker(matches);
    const matchLines = matches.map((m) => lineOfOffset(source, m.index ?? 0));
    const firstLine = matchLines[0]!;
    const lastLine = matchLines[matchLines.length - 1]!;

    const finding: Finding = {
      id: "",
      type: "todo_density",
      charge: "Unfinished Business",
      severity,
      confidence: 0.7,
      file: ctx.file,
      lines: [firstLine, lastLine],
      summary:
        matches.length === 1
          ? `1 TODO/FIXME marker in this file.`
          : `${matches.length} TODO/FIXME markers (${density.toFixed(1)} per 1k LOC). ` +
            `Each marker is intended behaviour the author flagged as not-final — too many in ` +
            `one file makes it hard for an agent to tell which logic is load-bearing.`,
      evidence: [
        Object.entries(breakdown)
          .map(([k, v]) => `${v}× ${k}`)
          .join(", "),
        `${density.toFixed(1)} markers per 1k LOC (threshold ${threshold})`,
      ],
      effort: "small",
      fix_shape: "convert TODOs to tickets or delete; comments are not tracking",
      scores: {
        severity: severityScore(severity),
        confidence: 0.7,
        // TODO markers are a weak signal — they describe intent gaps, not behavioural bugs.
        // Keep agent_risk modest unless the density is extreme.
        agent_risk: round(Math.min(0.2 + Math.max(ratio - 1, 0) * 0.05, 0.55)),
      },
      suggested_actions: [
        {
          kind: "triage_todos",
          description:
            "Convert each marker into a tracked issue or remove it. Lingering TODOs mislead " +
            "humans and agents about which behaviour is intentional.",
          risk: "low",
        },
      ],
    };

    return [finding];
  },
};

function countByMarker(matches: RegExpMatchArray[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of matches) {
    const key = m[0] ?? "TODO";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function pickSeverity(count: number, ratio: number): Severity {
  // TODO density is informational, not catastrophic. Only flag HIGH when the
  // file is genuinely overrun (many markers AND extreme density). Otherwise
  // medium for clearly elevated, and low for everything else that fires.
  if (count >= 20 && ratio >= 10) return "high";
  if (count >= 8 || ratio >= 10) return "medium";
  return "low";
}

function severityScore(s: Severity): number {
  return s === "high" ? 0.6 : s === "medium" ? 0.4 : 0.2;
}

function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) line += 1;
  }
  return line;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
