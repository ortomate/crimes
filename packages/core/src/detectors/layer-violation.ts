import type { CrimesConfig } from "../config.js";
import type { Detector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";
import type { ImportEdge, ImportGraph } from "../imports/types.js";

/**
 * Fires when a file imports another file that the configured
 * `architecture.rules` block. Consumes the 0.5.0
 * `architecture.layers` / `architecture.rules` config shape and the
 * import graph built once per scan; the cross-layer check is a pure
 * derivation over those two inputs.
 *
 * The detector emits one finding per `from` file with at least one
 * forbidden edge — multiple violations from the same file collapse into
 * one finding with extra evidence rows so the report doesn't spam the
 * same anchor.
 */
export const layerViolationDetector: Detector = {
  id: "layer_violation",
  name: "Layer Violation",
  description:
    "Flags imports that cross a layer boundary the configured " +
    "`architecture.rules` block.",
  whyItMatters:
    "Layer rules encode the team's agreed direction of change. When a " +
    "domain module reaches into the UI (or any other forbidden direction), " +
    "the next refactor in either layer becomes risky for both — and agents " +
    "editing one file rarely notice they have just widened the coupling.",

  pack: "language-js",
  run(ctx) {
    if (!ctx.imports) return [];
    const layers = ctx.config.architecture?.layers ?? [];
    const rules = ctx.config.architecture?.rules ?? [];
    if (layers.length === 0 || rules.length === 0) return [];

    const fromLayer = assignLayer(ctx.file, layers);
    if (fromLayer === undefined) return [];

    const outEdges = ctx.imports.out.get(ctx.file) ?? [];
    if (outEdges.length === 0) return [];

    type Violation = { edge: ImportEdge; toLayer: string; rule: LayerRule };

    const violations: Violation[] = [];
    for (const edge of outEdges) {
      if (edge.external) continue;
      if (edge.to.length === 0) continue;
      const toLayer = assignLayer(edge.to, layers);
      if (toLayer === undefined) continue;
      if (toLayer === fromLayer) continue;
      for (const rule of rules) {
        if (rule.from !== fromLayer) continue;
        if (!rule.cannotImport.includes(toLayer)) continue;
        violations.push({ edge, toLayer, rule });
        break;
      }
    }

    if (violations.length === 0) return [];

    const distinctRules = new Set(
      violations.map((v) => `${v.rule.from}→${v.toLayer}`),
    );
    const severity: Severity = violations.length >= 3 ? "high" : "medium";
    const confidence = 0.95;

    const evidence: string[] = [];
    for (const v of violations.slice(0, MAX_EVIDENCE_EDGES)) {
      evidence.push(
        `${ctx.file} (layer: ${fromLayer}) imports ${v.edge.to} ` +
          `(layer: ${v.toLayer})`,
      );
    }
    if (violations.length > MAX_EVIDENCE_EDGES) {
      evidence.push(
        `+${violations.length - MAX_EVIDENCE_EDGES} more forbidden edge` +
          (violations.length - MAX_EVIDENCE_EDGES === 1 ? "" : "s"),
      );
    }
    for (const ruleKey of distinctRules) {
      const [from, to] = ruleKey.split("→");
      evidence.push(`rule: ${from} cannotImport ${to}`);
    }

    const related = Array.from(new Set(violations.map((v) => v.edge.to))).sort();

    const finding: Finding = {
      id: "",
      type: "layer_violation",
      charge: "Layer Violation",
      severity,
      confidence,
      file: ctx.file,
      summary:
        `${ctx.file} (layer: ${fromLayer}) appears to import ${violations.length} ` +
        `file${violations.length === 1 ? "" : "s"} the configured architecture ` +
        "rules forbid. Crossing a layer boundary may invert the team's intended " +
        "direction of change.",
      evidence,
      effort: "medium",
      fix_shape: "route through the layer boundary or relocate the consumer",
      scores: {
        severity: severityScore(severity),
        confidence,
      },
      suggested_actions: [
        {
          kind: "respect_layer_boundary",
          description:
            "Move the cross-layer collaboration behind an interface owned " +
            `by the ${fromLayer} layer, or relax the rule in ` +
            "`crimes.config.json` if the team has decided otherwise.",
          risk: "medium",
        },
      ],
      related_files: related.length > 0 ? related : undefined,
    };

    return [finding];
  },
};

interface LayerDef {
  name: string;
  pattern: string;
}

interface LayerRule {
  from: string;
  cannotImport: string[];
}

const MAX_EVIDENCE_EDGES = 5;

function severityScore(s: Severity): number {
  return s === "high" ? 0.85 : s === "medium" ? 0.6 : 0.35;
}

/**
 * First-match-wins layer assignment. Returns `undefined` when no layer
 * pattern matches — those files are silently skipped from the finding
 * pipeline rather than mis-attributed.
 */
function assignLayer(
  file: string,
  layers: LayerDef[],
): string | undefined {
  for (const layer of layers) {
    if (matchPattern(layer.pattern, file)) return layer.name;
  }
  return undefined;
}

/**
 * Minimal POSIX-style glob matcher. Supports `*` (single segment) and
 * `**` (any number of segments). Anchored to the full repo-relative
 * path — patterns are treated as written, not auto-prefixed with `**`.
 *
 * Equivalent enough to picomatch for the patterns architecture rules
 * use in practice (`src/components/**`, `**\/billing/**`, `apps/web/**`).
 */
function matchPattern(pattern: string, file: string): boolean {
  const re = globToRegex(pattern);
  return re.test(file);
}

function globToRegex(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — any number of characters (including `/`).
        out += ".*";
        i += 2;
        // Swallow a trailing slash so `src/x/**/y` matches `src/x/y`.
        if (pattern[i] === "/") i += 1;
        continue;
      }
      // `*` — any number of non-slash characters.
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (".+^$(){}|[]\\".includes(c)) {
      out += `\\${c}`;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

// Re-export the helper so the dependency-graph detectors can reuse the
// same matcher without re-implementing it.
export { matchPattern as matchLayerPattern };

// Surface the shapes for tests that build their own contexts.
export type { CrimesConfig };
