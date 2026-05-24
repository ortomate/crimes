import type { CrimesConfig } from "../config.js";
import type { LanguageJsDetector } from "../detector.js";
import type { PreFinding as Finding, Severity } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

type LargeFileShape = "domain" | "test_file";

/**
 * Per-shape size policy. `domain` reads the configured threshold so existing
 * `crimes.config.json` setups keep working; the `test_file` shape uses a much
 * higher threshold because test suites legitimately grow with many small
 * `it()` blocks.
 *
 *   shape      | threshold | sev @ thr | sev @ 2× thr
 *   -----------+-----------+-----------+-------------
 *   domain     | config    | medium    | high
 *   test_file  |   1500    | low       | medium
 */
interface LargeFilePolicy {
  threshold: number;
  severityAtThreshold: Severity;
  severityAtTwoX: Severity;
  label: string;
  agentRiskScale: number;
}

/**
 * Resolve the size policy for one file. The `domain` threshold comes from
 * `thresholds.largeFile.domain` when set, else the legacy
 * `thresholds.largeFileLines` (kept for back-compat). The `test_file`
 * threshold honours `thresholds.largeFile.test_file` when present; otherwise
 * the built-in 1500-line default applies.
 */
export function policyForFile(
  shape: LargeFileShape,
  config: CrimesConfig,
): LargeFilePolicy {
  const overrides = config.thresholds.largeFile;
  if (shape === "test_file") {
    return {
      threshold: overrides?.test_file ?? 1500,
      severityAtThreshold: "low",
      severityAtTwoX: "medium",
      label: "test file",
      agentRiskScale: 0.5,
    };
  }
  return {
    threshold: overrides?.domain ?? config.thresholds.largeFileLines,
    severityAtThreshold: "medium",
    severityAtTwoX: "high",
    label: "file",
    agentRiskScale: 1,
  };
}

export function shapeForFile(file: string): LargeFileShape {
  return isTestFile(file) ? "test_file" : "domain";
}

export const largeFileDetector: LanguageJsDetector = {
  id: "large_file",
  name: "Large File",
  description:
    "Flags files that exceed a per-shape line-count threshold " +
    "(domain code and test files each carry their own budget).",
  whyItMatters:
    "Files this large are hard to read in one breath and exceed many " +
    "agents' practical context budget. They concentrate unrelated changes, " +
    "so every PR's diff is harder to review and easier to break. Splitting " +
    "by responsibility keeps each module independently understandable.",

  pack: "language-js",
  run(ctx) {
    const shape = shapeForFile(ctx.file);
    const policy = policyForFile(shape, ctx.config);
    const lines = ctx.parsed.lineCount;

    if (lines <= policy.threshold) return [];

    const ratio = lines / policy.threshold;
    const severity =
      ratio >= 2 ? policy.severityAtTwoX : policy.severityAtThreshold;
    const confidence = Math.min(0.7 + (ratio - 1) * 0.15, 0.95);
    const fnCount = ctx.parsed.functions.length;

    const isDomain = shape === "domain";
    const summary = isDomain
      ? `File is ${lines} lines (threshold ${policy.threshold}). Modules this large hide local coupling: small edits can collide with code an agent never loaded into context.`
      : `${capitalise(policy.label)} is ${lines} lines (${policy.label} threshold ${policy.threshold}). Modules this large hide local coupling: small edits can collide with code an agent never loaded into context.`;
    const thresholdEvidence = isDomain
      ? `${ratio.toFixed(1)}× the configured ${policy.threshold}-line threshold`
      : `${ratio.toFixed(1)}× the configured ${policy.threshold}-line ${policy.label} threshold`;

    const finding: Finding = {
      id: "", // filled in by scan.ts
      type: "large_file",
      charge: "God File",
      severity,
      confidence: round(confidence),
      file: ctx.file,
      lines: [1, lines],
      summary,
      evidence: [
        `${lines} non-empty lines`,
        thresholdEvidence,
        `${fnCount} top-level function${fnCount === 1 ? "" : "s"} declared in this file`,
        ...(shape === "test_file"
          ? ["shape: test file (matches **/*.{test,spec}.[jt]sx? or __tests__/)"]
          : []),
      ],
      effort: "medium",
      fix_shape: "split by responsibility; one concern per module",
      scores: {
        severity: severityScore(severity),
        confidence: round(confidence),
        agent_risk: round(
          Math.min(
            0.45 * policy.agentRiskScale + (ratio - 1) * 0.18,
            0.9,
          ),
        ),
      },
      suggested_actions: [
        {
          kind: "split_file",
          description: suggestedActionFor(shape),
          risk: "medium",
        },
      ],
    };

    return [finding];
  },
};

function suggestedActionFor(shape: LargeFileShape): string {
  if (shape === "test_file") {
    return (
      "Split the suite into per-feature or per-scenario files so each " +
      "behaviour can be discovered, run, and diffed in isolation."
    );
  }
  return (
    "Split along clear responsibility boundaries. Smaller modules give " +
    "humans and agents a smaller surface to reason about per edit."
  );
}

function severityScore(s: Severity): number {
  return s === "high" ? 0.85 : s === "medium" ? 0.6 : 0.35;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
