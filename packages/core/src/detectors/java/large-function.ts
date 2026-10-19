import type { JavaMethodShape } from "@crimes/language-java";
import { z } from "zod";
import type { LanguageJavaDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { resolveDiscriminators } from "../disambiguate.js";
import { round, severityScore } from "../py/shared.js";

/**
 * Per-shape line budgets. `domain` defaults to the configured
 * `thresholds.largeFunctionLines` (60), the JS budget: Java is wordier
 * than TypeScript per statement, but its long methods are long for the
 * same reason — several steps written inline. Tests and constructors get
 * more room because their length is conventional surface area.
 */
const SHAPE_THRESHOLDS: Record<Exclude<JavaMethodShape, "domain">, number> = {
  test_method: 150,
  constructor: 80,
};

const optionsSchema = z
  .object({
    thresholds: z
      .object({
        domain: z.number().int().positive().optional(),
        test_method: z.number().int().positive().optional(),
        constructor: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

export const largeFunctionJavaDetector: LanguageJavaDetector = {
  id: "large_function.java",
  claims: ["too_long"],
  name: "God Function (Java)",
  description:
    "Flags Java methods and constructors that run past a shape-appropriate line budget.",
  whyItMatters:
    "A long method is one an agent has to hold entirely in context before it can " +
    "change any part of it safely, and the longer it is the more likely an edit " +
    "breaks a branch nobody re-read. Extracting named private methods turns an " +
    "implicit sequence of steps into one the reader — and the next agent — can see.",

  pack: "language-java",
  optionsSchema,
  run(ctx) {
    const overrides = readOptions(ctx.config);
    const findings: Finding[] = [];

    for (const method of ctx.parsed.methods) {
      if (!method.hasBody) continue;
      // Own properties only: "constructor" is a shape name, and a plain
      // object lookup of it returns `Object.prototype.constructor`.
      const override = Object.hasOwn(overrides, method.shape)
        ? overrides[method.shape]
        : undefined;
      const threshold =
        override ??
        (method.shape === "domain"
          ? ctx.config.thresholds.largeFunctionLines
          : SHAPE_THRESHOLDS[method.shape]);
      const lines = method.endLine - method.startLine + 1;
      if (lines <= threshold) continue;

      const overage = lines / threshold;
      const severity = pickSeverity(overage, method.shape);
      const evidence = [
        `${lines} lines (threshold ${threshold} for shape "${method.shape}")`,
        `nesting depth ${method.maxNestingDepth}`,
        `${method.paramCount} parameter${method.paramCount === 1 ? "" : "s"}`,
        ...method.shapeEvidence.map((reason) => `shape: ${reason}`),
        ...(method.className !== undefined ? [`member of ${method.className}`] : []),
      ];

      findings.push({
        id: "",
        type: "large_function",
        charge: "God Function",
        severity,
        confidence: 0.9,
        file: ctx.file,
        symbol: method.name,
        // Overloads share a name within a class; arity separates them and
        // is a property of the code, not of its position. Dropped again
        // wherever the name is unique in the file.
        discriminator: `${method.className ?? ""}(${method.paramCount})`,
        lines: [method.startLine, method.endLine],
        claim: "too_long",
        summary:
          `\`${method.name}\` is ${lines} lines. At this size an agent must read the ` +
          "whole body before it can safely change any part of it.",
        evidence,
        effort: "small",
        fix_shape: "extract pure helpers; keep the orchestrator thin",
        scores: {
          severity: severityScore(severity),
          confidence: 0.9,
          agent_risk: round(Math.min(0.4 + Math.min(overage - 1, 1.5) * 0.22, 0.85)),
        },
        suggested_actions: [
          {
            kind: "extract_function",
            description:
              `Extract the distinct steps of \`${method.name}\` into named private ` +
              "methods so each can be read and tested on its own.",
            risk: "low",
          },
        ],
      });
    }

    resolveDiscriminators(findings);
    return findings;
  },
};

function pickSeverity(overage: number, shape: JavaMethodShape): Severity {
  // A long test is conventional bulk, not a hazard; mirrors JS and Python.
  if (shape === "test_method") return "low";
  if (overage >= 2.5) return "high";
  if (overage >= 1.4) return "medium";
  return "low";
}

function readOptions(
  config: Parameters<LanguageJavaDetector["run"]>[0]["config"],
): Partial<Record<JavaMethodShape, number>> {
  const raw = config.detectors?.options?.["large_function.java"];
  const parsed = optionsSchema.safeParse(raw ?? {});
  if (!parsed.success) return {};
  return parsed.data.thresholds ?? {};
}

/** Exported for the unit tests, which assert the shipped budgets. */
export const JAVA_LARGE_FUNCTION_THRESHOLDS = SHAPE_THRESHOLDS;
