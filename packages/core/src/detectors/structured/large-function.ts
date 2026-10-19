import { z } from "zod";
import type { Detector } from "../../detector.js";
import type { PreFinding as Finding, Severity } from "../../finding.js";
import { resolveDiscriminators } from "../disambiguate.js";
import { round, severityScore } from "../py/shared.js";
import type {
  LanguageProfile,
  StructuredContext,
  StructuredPack,
  StructuredShape,
} from "./surface.js";

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

/**
 * God Function for a structured-surface language.
 *
 * `domain` uses the configured `thresholds.largeFunctionLines` (60), the
 * JS budget; tests and constructors get the profile's larger budgets
 * because their length is conventional surface area.
 */
export function makeLargeFunctionDetector<P extends StructuredPack>(
  profile: LanguageProfile<P>,
): Extract<Detector, { pack: P }> {
  const budgets = profile.largeFunction.budgets;
  const detector = {
    id: `large_function.${profile.suffix}`,
    claims: ["too_long"],
    name: `God Function (${profile.label})`,
    description: profile.largeFunction.description,
    whyItMatters: profile.largeFunction.whyItMatters,
    pack: profile.pack,
    optionsSchema,
    run(ctx: StructuredContext): Finding[] {
      const overrides = readOptions(ctx.config, detector.id);
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
            : budgets[method.shape]);
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
          // Overloads share a name within a type; arity separates them and
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
                `Extract the distinct steps of \`${method.name}\` into ` +
                `${profile.largeFunction.extractInto} so each can be read and tested on its own.`,
              risk: "low",
            },
          ],
        });
      }

      resolveDiscriminators(findings);
      return findings;
    },
  };
  return detector as unknown as Extract<Detector, { pack: P }>;
}

function pickSeverity(overage: number, shape: StructuredShape): Severity {
  // A long test is conventional bulk, not a hazard; mirrors JS and Python.
  if (shape === "test_method") return "low";
  if (overage >= 2.5) return "high";
  if (overage >= 1.4) return "medium";
  return "low";
}

function readOptions(
  config: StructuredContext["config"],
  id: string,
): Partial<Record<StructuredShape, number>> {
  const raw = config.detectors?.options?.[id];
  const parsed = optionsSchema.safeParse(raw ?? {});
  if (!parsed.success) return {};
  return parsed.data.thresholds ?? {};
}
