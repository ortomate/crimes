import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import type { ImportGraph } from "../imports/types.js";

/**
 * Fires on files whose in-degree (number of importers) or out-degree
 * (number of imports) sits at or above the 95th percentile of the repo's
 * distribution. The 99th-percentile slice escalates from low to medium.
 *
 * The detector is intentionally non-judgemental: high fan-in is often a
 * deliberate shared utility, not a bug. The wedge is agent-edit-risk —
 * surfacing these files as "rippling" so an agent making a small change
 * understands how many other files will need a re-read.
 */
export const highFanInFanOutDetector: LanguageJsDetector = {
  id: "high_fan_in_fan_out",
  name: "High Fan-In / Fan-Out",
  description:
    "Flags files with unusually many importers (fan-in) or imports " +
    "(fan-out) relative to the repo's distribution.",
  whyItMatters:
    "Files this connected ripple widely on every edit: small refactors " +
    "touch many call sites, and small bugs reach many consumers. An " +
    "agent should treat them as load-bearing — read the importers before " +
    "renaming or restructuring.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.imports) return [];
    const stats = buildOrLoadStats(ctx.imports);
    if (stats.fanInCutoff === undefined || stats.fanOutCutoff === undefined) {
      return [];
    }

    const fanIn = (ctx.imports.in.get(ctx.file) ?? []).length;
    const fanOut = countLocalOut(ctx.imports, ctx.file);

    const overFanIn = fanIn >= stats.fanInCutoff;
    const overFanOut = fanOut >= stats.fanOutCutoff;
    if (!overFanIn && !overFanOut) return [];

    const inP99 = fanIn >= stats.fanInP99;
    const outP99 = fanOut >= stats.fanOutP99;
    const severity: Severity = inP99 || outP99 ? "medium" : "low";
    const confidence = 0.7;

    const evidence: string[] = [];
    if (overFanIn) {
      evidence.push(
        `fan-in: ${fanIn} importer${fanIn === 1 ? "" : "s"} ` +
          `(p95 cutoff: ${stats.fanInCutoff}, p99: ${stats.fanInP99})`,
      );
    }
    if (overFanOut) {
      evidence.push(
        `fan-out: ${fanOut} import${fanOut === 1 ? "" : "s"} ` +
          `(p95 cutoff: ${stats.fanOutCutoff}, p99: ${stats.fanOutP99})`,
      );
    }

    const finding: Finding = {
      id: "",
      type: "high_fan_in_fan_out",
      charge: "High Fan-In / Fan-Out",
      severity,
      confidence,
      file: ctx.file,
      summary:
        `${ctx.file} appears to be in the repo's top connectivity tier (` +
        `fan-in ${fanIn}, fan-out ${fanOut}). Edits here ripple widely; ` +
        "treat as load-bearing before refactoring.",
      evidence,
      effort: "medium",
      fix_shape: "split or invert: too many consumers means too much coupling",
      scores: {
        severity: severityScore(severity),
        confidence,
      },
      suggested_actions: [
        {
          kind: "treat_as_load_bearing",
          description:
            "Before changing this file, read the importers / imports list " +
            "and prefer additive changes over restructuring.",
          risk: "low",
        },
      ],
    };

    return [finding];
  },
};

interface FanStats {
  fanInCutoff: number | undefined;
  fanOutCutoff: number | undefined;
  fanInP99: number;
  fanOutP99: number;
}

const STATS_CACHE = new WeakMap<ImportGraph, FanStats>();

function buildOrLoadStats(graph: ImportGraph): FanStats {
  const cached = STATS_CACHE.get(graph);
  if (cached) return cached;
  const fresh = computeStats(graph);
  STATS_CACHE.set(graph, fresh);
  return fresh;
}

function computeStats(graph: ImportGraph): FanStats {
  const files = [...graph.files];
  if (files.length < 5) {
    // Not enough files to compute a meaningful percentile.
    return {
      fanInCutoff: undefined,
      fanOutCutoff: undefined,
      fanInP99: Number.POSITIVE_INFINITY,
      fanOutP99: Number.POSITIVE_INFINITY,
    };
  }

  const fanIns: number[] = [];
  const fanOuts: number[] = [];
  for (const f of files) {
    fanIns.push((graph.in.get(f) ?? []).length);
    fanOuts.push(countLocalOut(graph, f));
  }
  fanIns.sort((a, b) => a - b);
  fanOuts.sort((a, b) => a - b);

  return {
    fanInCutoff: Math.max(percentile(fanIns, 0.95), MIN_FAN_THRESHOLD),
    fanOutCutoff: Math.max(percentile(fanOuts, 0.95), MIN_FAN_THRESHOLD),
    fanInP99: Math.max(percentile(fanIns, 0.99), MIN_P99_THRESHOLD),
    fanOutP99: Math.max(percentile(fanOuts, 0.99), MIN_P99_THRESHOLD),
  };
}

/**
 * Count the file's local out-edges — bare modules don't ripple inside
 * the repo, so they don't count toward the fan-out signal even though
 * they exist on the edges list.
 */
function countLocalOut(graph: ImportGraph, file: string): number {
  const edges = graph.out.get(file) ?? [];
  let count = 0;
  for (const e of edges) {
    if (e.external) continue;
    if (e.to.length === 0) continue;
    count += 1;
  }
  return count;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor(p * (sorted.length - 1)),
  );
  return sorted[idx]!;
}

const MIN_FAN_THRESHOLD = 5;
const MIN_P99_THRESHOLD = 8;

function severityScore(s: Severity): number {
  return s === "high" ? 0.85 : s === "medium" ? 0.6 : 0.35;
}
