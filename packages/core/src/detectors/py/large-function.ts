import type { PyFunctionShape } from "@crimes/language-py";
import { z } from "zod";
import type { LanguagePyDetector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { intrinsicFor, round, severityScore } from "./shared.js";

/**
 * Per-shape line budgets.
 *
 * These are *not* the JS numbers copied across. Python is denser than
 * TS/JS at the same level of complexity — no braces, no import
 * boilerplate, comprehensions where JS needs a loop — so the domain
 * budget is tighter than JS's 60 rather than looser. The framework
 * shapes get more room for the same reason they do on the JS side:
 * their size is conventional surface area, not branching logic.
 */
const SHAPE_THRESHOLDS: Record<PyFunctionShape, number> = {
  domain: 50,
  route_handler: 80,
  django_view: 80,
  cli_command: 120,
  test_function: 150,
  dunder: 70,
  unknown: 60,
};

/**
 * Nesting depth at which a function is called out regardless of length.
 * A short function four levels deep is harder for an agent to edit
 * safely than a long flat one.
 */
const DEEP_NESTING = 4;

const optionsSchema = z
  .object({
    thresholds: z
      .object({
        domain: z.number().int().positive().optional(),
        route_handler: z.number().int().positive().optional(),
        django_view: z.number().int().positive().optional(),
        cli_command: z.number().int().positive().optional(),
        test_function: z.number().int().positive().optional(),
        dunder: z.number().int().positive().optional(),
        unknown: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

export const largeFunctionPyDetector: LanguagePyDetector = {
  id: "large_function.py",
  name: "God Function (Python)",
  description:
    "Flags Python functions that run past a shape-appropriate line budget, or nest " +
    "compound statements more than four levels deep.",
  whyItMatters:
    "A long function is one an agent has to hold entirely in context before it can " +
    "change any part of it safely, and the longer it is the more likely an edit " +
    "silently breaks a branch nobody re-read. Python makes this worse than most " +
    "languages because control flow is carried by indentation: a mis-indented line " +
    "is still valid code, just attached to a different block. Splitting into named " +
    "helpers turns an implicit structure into one the reader — and the next agent — " +
    "can see.",

  pack: "language-py",
  optionsSchema,
  run(ctx) {
    const options = readOptions(ctx.config);
    const findings: Finding[] = [];

    for (const fn of ctx.parsed.functions) {
      if (fn.name === undefined) continue;
      const threshold = options[fn.shape] ?? SHAPE_THRESHOLDS[fn.shape];
      const lines = fn.endLine - fn.startLine + 1;
      const tooLong = lines > threshold;
      const tooDeep = fn.maxNestingDepth >= DEEP_NESTING;
      if (!tooLong && !tooDeep) continue;

      const overage = tooLong ? lines / threshold : 1;
      const severity = pickSeverity({ overage, tooDeep, shape: fn.shape });

      const evidence: string[] = [
        `${lines} lines (threshold ${threshold} for shape "${fn.shape}")`,
        `nesting depth ${fn.maxNestingDepth}`,
        `${fn.paramCount} parameter${fn.paramCount === 1 ? "" : "s"}`,
      ];
      for (const reason of fn.shapeEvidence ?? []) evidence.push(`shape: ${reason}`);
      if (fn.className !== undefined) evidence.push(`method on ${fn.className}`);
      if (tooDeep) {
        evidence.push(
          `nesting reaches ${fn.maxNestingDepth} levels — each level is a branch a reader has to keep on the stack`,
        );
      }

      findings.push({
        id: "",
        type: "large_function",
        charge: "God Function",
        severity,
        confidence: 0.9,
        file: ctx.file,
        symbol: fn.name,
        lines: [fn.startLine, fn.endLine],
        summary:
          `\`${fn.name}\` is ${lines} lines` +
          (tooDeep ? ` and nests ${fn.maxNestingDepth} levels deep` : "") +
          `. At this size an agent must read the whole body before it can safely ` +
          `change any part of it.`,
        evidence,
        effort: "small",
        fix_shape: "extract pure helpers; keep the orchestrator thin",
        scores: {
          severity: severityScore(severity),
          confidence: 0.9,
          // Scales with how far past budget the function runs, with a
          // deep-nesting surcharge — an agent's chance of a bad edit
          // tracks both, not length alone.
          agent_risk: round(
            Math.min(
              0.40 + Math.min(overage - 1, 1.5) * 0.22 + (tooDeep ? 0.12 : 0),
              0.88,
            ),
          ),
        },
        suggested_actions: [
          {
            kind: "extract_function",
            description:
              `Extract the distinct steps of \`${fn.name}\` into named helpers so each ` +
              `can be read and tested on its own.`,
            risk: "low",
          },
        ],
      });
    }

    return findings;
  },
};

function pickSeverity(args: {
  overage: number;
  tooDeep: boolean;
  shape: PyFunctionShape;
}): Severity {
  const { overage, tooDeep, shape } = args;
  // A long test or CLI command is conventional bulk, not a hazard —
  // surface it, but never above low. Mirrors the JS shape policy.
  if (shape === "test_function" || shape === "cli_command") return "low";
  if (overage >= 2.5) return "high";
  if (overage >= 1.4 || tooDeep) return "medium";
  return "low";
}

function readOptions(
  config: LanguagePyDetectorConfig,
): Partial<Record<PyFunctionShape, number>> {
  const raw = config.detectors?.options?.["large_function.py"];
  const parsed = optionsSchema.safeParse(raw ?? {});
  if (!parsed.success) return {};
  return parsed.data.thresholds ?? {};
}

type LanguagePyDetectorConfig = Parameters<
  LanguagePyDetector["run"]
>[0]["config"];

/** Exported for the unit tests, which assert the shipped budgets. */
export const PY_LARGE_FUNCTION_THRESHOLDS = SHAPE_THRESHOLDS;
export const PY_DEEP_NESTING_THRESHOLD = DEEP_NESTING;
