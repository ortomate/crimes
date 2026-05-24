import type { FunctionShape, ParsedFunction } from "@crimes/language-js";
import type { CrimesConfig } from "../config.js";
import type { Detector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";

/**
 * Per-shape size policy. `domain` reads the configured threshold so
 * existing `crimes.config.json` setups keep working; the other shapes
 * use fixed values reflecting what looks normal for that surface.
 *
 *   shape                  | threshold | sev @ thr | sev @ 2× thr
 *   -----------------------+-----------+-----------+-------------
 *   domain                 | config    | medium    | high
 *   route_handler          | 100       | medium    | high
 *   react_component        | 200       | medium    | high
 *   page_export            | 200       | medium    | high
 *   test_callback          | 200       | low       | medium
 *   cli_command_registrar  | 200       | low       | medium
 *   unknown                |  80       | medium    | high
 */
interface ShapePolicy {
  threshold: number;
  /** Severity assigned at `ratio < 2`. */
  severityAtThreshold: Severity;
  /** Severity assigned at `ratio >= 2`. */
  severityAtTwoX: Severity;
  /** Human label used inside `summary` and `evidence`. */
  label: string;
  /** Lower agent-risk weighting (test callbacks shouldn't dominate). */
  agentRiskScale: number;
}

const DEFAULT_POLICIES: Record<Exclude<FunctionShape, "domain">, ShapePolicy> = {
  test_callback: {
    threshold: 200,
    severityAtThreshold: "low",
    severityAtTwoX: "medium",
    label: "test callback",
    agentRiskScale: 0.6,
  },
  react_component: {
    threshold: 200,
    severityAtThreshold: "medium",
    severityAtTwoX: "high",
    label: "React component",
    agentRiskScale: 0.85,
  },
  page_export: {
    threshold: 200,
    severityAtThreshold: "medium",
    severityAtTwoX: "high",
    label: "page component",
    agentRiskScale: 0.85,
  },
  route_handler: {
    threshold: 100,
    severityAtThreshold: "medium",
    severityAtTwoX: "high",
    label: "route handler",
    agentRiskScale: 1,
  },
  cli_command_registrar: {
    threshold: 200,
    severityAtThreshold: "low",
    severityAtTwoX: "medium",
    label: "CLI command registrar",
    agentRiskScale: 0.6,
  },
  unknown: {
    threshold: 80,
    severityAtThreshold: "medium",
    severityAtTwoX: "high",
    label: "function",
    agentRiskScale: 1,
  },
};

/**
 * Resolve the size policy for one shape. The `domain` shape's threshold
 * comes from `thresholds.largeFunction.domain` when set, else the legacy
 * `thresholds.largeFunctionLines` (kept for back-compat). Other shapes
 * honour `thresholds.largeFunction.<shape>` overrides when present;
 * otherwise they use the built-in defaults.
 */
export function policyFor(
  shape: FunctionShape,
  config: CrimesConfig,
): ShapePolicy {
  const overrides = config.thresholds.largeFunction;
  if (shape === "domain") {
    return {
      threshold:
        overrides?.domain ?? config.thresholds.largeFunctionLines,
      severityAtThreshold: "medium",
      severityAtTwoX: "high",
      label: "domain function",
      agentRiskScale: 1,
    };
  }
  // `DEFAULT_POLICIES` is a complete `Record<Exclude<FunctionShape, "domain">, …>`
  // so the lookup always succeeds, but strict index access types it as
  // possibly undefined. Falling back to the `unknown` policy keeps the
  // signature total without weakening the runtime guarantee.
  const base = DEFAULT_POLICIES[shape] ?? DEFAULT_POLICIES.unknown;
  const override = overrides?.[shape];
  if (override === undefined) return base;
  return { ...base, threshold: override };
}

export const largeFunctionDetector: Detector = {
  id: "large_function",
  name: "Large Function",
  description:
    "Flags functions whose body exceeds a per-shape line threshold " +
    "(domain code, React components, route handlers, page exports, " +
    "and test callbacks each carry their own budget).",
  whyItMatters:
    "Functions this large mix multiple responsibilities into one body. " +
    "An agent editing one section often misses interactions in another, " +
    "and the function becomes a magnet for further duplication. Smaller, " +
    "named helpers give every editor — human or AI — a smaller surface " +
    "to reason about per edit.",

  pack: "language-js",
  run(ctx) {
    const findings: Finding[] = [];

    for (const fn of ctx.parsed.functions) {
      const length = fn.endLine - fn.startLine + 1;
      const policy = policyFor(fn.shape, ctx.config);
      if (length <= policy.threshold) continue;

      const ratio = length / policy.threshold;
      const severity =
        ratio >= 2 ? policy.severityAtTwoX : policy.severityAtThreshold;
      const confidence = Math.min(0.8 + (ratio - 1) * 0.1, 0.95);
      const symbol = symbolFor(fn);

      findings.push({
        id: "",
        type: "large_function",
        charge: "God Function",
        severity,
        confidence: round(confidence),
        file: ctx.file,
        symbol,
        lines: [fn.startLine, fn.endLine],
        summary: buildSummary({ symbol, length, policy }),
        evidence: buildEvidence({ fn, length, policy, ratio }),
        effort: "small",
        fix_shape: "extract pure helpers; keep the orchestrator thin",
        scores: {
          severity: severityScore(severity),
          confidence: round(confidence),
          agent_risk: round(
            Math.min(
              0.55 * policy.agentRiskScale + (ratio - 1) * 0.2,
              0.95,
            ),
          ),
        },
        suggested_actions: [
          {
            kind: "extract_function",
            description: suggestedActionFor(fn.shape),
            risk: "low",
          },
        ],
      });
    }

    return findings;
  },
};

function symbolFor(fn: ParsedFunction): string {
  if (fn.name) return fn.name;
  if (fn.shape === "test_callback") {
    // Test callbacks are usually anonymous arrows; surface the callee
    // (e.g. `describe`) so the human report has something to call them.
    const calleeEvidence = fn.shapeEvidence?.find((e) =>
      e.startsWith("callback passed to "),
    );
    if (calleeEvidence) {
      const m = /callback passed to ([a-zA-Z_$][\w$]*)\(/.exec(calleeEvidence);
      if (m) return `${m[1]} callback`;
    }
  }
  if (fn.shape === "cli_command_registrar") {
    return "action callback";
  }
  return "<anonymous>";
}

function buildSummary(args: {
  symbol: string;
  length: number;
  policy: ShapePolicy;
}): string {
  const { symbol, length, policy } = args;
  const subject =
    symbol === "<anonymous>" ? `An anonymous ${policy.label}` : symbol;
  return (
    `${subject} is ${length} lines long ` +
    `(${policy.label} threshold ${policy.threshold}). ` +
    "Bodies this size usually mix unrelated responsibilities, and an " +
    "agent editing one section often misses interactions in another."
  );
}

function buildEvidence(args: {
  fn: ParsedFunction;
  length: number;
  policy: ShapePolicy;
  ratio: number;
}): string[] {
  const { fn, length, policy, ratio } = args;
  const evidence: string[] = [
    `lines ${fn.startLine}–${fn.endLine} (${length} lines)`,
    `${ratio.toFixed(1)}× the ${policy.label} threshold (${policy.threshold} lines)`,
  ];
  evidence.push(
    fn.kind === "method"
      ? "class method — invariants are likely shared with sibling methods"
      : `${fn.kind.replace("_", " ")} declaration`,
  );
  // Append the shape evidence the parser captured so a reader can
  // verify why this size budget was applied. For domain and unknown
  // shapes there's usually no additional evidence — skip the line.
  if (fn.shapeEvidence && fn.shapeEvidence.length > 0) {
    evidence.push(`shape: ${policy.label} (${fn.shapeEvidence.join("; ")})`);
  }
  return evidence;
}

function suggestedActionFor(shape: FunctionShape): string {
  switch (shape) {
    case "react_component":
    case "page_export":
      return (
        "Extract markup-only sections into named sub-components and " +
        "pure data helpers so the rendering, data, and effect concerns " +
        "can be read in isolation."
      );
    case "route_handler":
      return (
        "Extract request parsing, authorisation, and persistence into " +
        "named helpers so the handler reads as a flow of named steps."
      );
    case "test_callback":
      return (
        "Split the suite into focused describe blocks or per-scenario " +
        "tests so each behaviour is independently runnable and diffable."
      );
    case "cli_command_registrar":
      return (
        "Move the action body into a named exported function and let the " +
        "registrar stay as a thin Commander DSL chain — the chain itself " +
        "is declarative and rarely needs editing."
      );
    default:
      return (
        "Extract cohesive sections into named helpers so each " +
        "responsibility can be read, tested, and edited in isolation."
      );
  }
}

function severityScore(s: Severity): number {
  return s === "high" ? 0.9 : s === "medium" ? 0.7 : 0.45;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
