/**
 * The `language-less` detector slate.
 *
 * One charge, for what LESS hides: variables evaluate lazily and the
 * last top-level definition in a bundle wins for every use, including
 * uses written before it. A definition a later import redefines does
 * nothing, in a file that gives no sign of it. The bundle simulation is
 * in `@crimes/language-less` (`findOverriddenVariables`); it runs once per
 * scan, and this detector reports what it found for the file in hand.
 */

import { composeClaim } from "../../claims.js";
import type {
  LanguageLessDetector,
  LanguageLessDetectorContext,
} from "../../detector.js";
import type { PreFinding as Finding } from "../../finding.js";
import { classifyScope } from "../../util/scope-class.js";
import { resolveDiscriminators } from "../disambiguate.js";
import { round, severityScore } from "../py/shared.js";

const MAX_FINDINGS_PER_FILE = 8;

export const overriddenVariableDetector: LanguageLessDetector = {
  id: "overridden_variable.less",
  claims: ["different_value", "same_value"],
  name: "Overruled Variable (LESS)",
  description:
    "Flags top-level LESS variable definitions that a later definition overrides in " +
    "every bundle that compiles them.",
  whyItMatters:
    "LESS uses the last definition of a variable everywhere in a bundle, even above " +
    "it. An override that a later import undoes never applies, and an edit to the " +
    "losing definition changes nothing — an agent changing the value it can see is " +
    "changing dead code.",
  pack: "language-less",
  run(ctx: LanguageLessDetectorContext): Finding[] {
    const scope = classifyScope(ctx.file);
    if (scope !== "production" && scope !== "config") return [];
    const findings: Finding[] = [];
    for (const o of ctx.less?.overridden ?? []) {
      if (findings.length >= MAX_FINDINGS_PER_FILE) break;
      const same = o.value !== undefined && o.value === o.winner.value;
      const kind = same ? "same_value" : "different_value";
      const severity = same ? "low" : "medium";
      const confidence = same ? 0.85 : 0.8;
      const where =
        o.winner.file === o.file
          ? `line ${o.winner.line}`
          : `${o.winner.file}:${o.winner.line}`;
      const bundles =
        o.bundles.length === 1
          ? `the bundle ${o.bundles[0]}`
          : `all ${o.bundles.length} bundles that compile it`;
      findings.push({
        id: "",
        type: "overridden_variable",
        charge: "Overruled Variable",
        severity,
        confidence,
        file: ctx.file,
        lines: [o.line, o.line],
        symbol: `@${o.name}`,
        discriminator: String(o.line),
        claim: composeClaim([kind]),
        summary: same
          ? `\`@${o.name}\` is defined again at ${where} with the same value; this definition is never the one used, so editing it changes nothing.`
          : `\`@${o.name}: ${o.value ?? "…"}\` never applies: ${where} redefines it as \`${o.winner.value ?? "…"}\`, and LESS uses the last definition everywhere in ${bundles}.`,
        evidence: [
          `defined here: \`@${o.name}: ${o.value ?? "…"}\` (line ${o.line})`,
          `overridden by: \`@${o.name}: ${o.winner.value ?? "…"}\` at ${o.winner.file}:${o.winner.line}`,
          `bundles: ${o.bundles.slice(0, 3).join(", ")}${o.bundles.length > 3 ? ` (+${o.bundles.length - 3} more)` : ""}`,
          "no bundle that compiles this file uses this definition",
        ],
        effort: "quick",
        fix_shape: same
          ? "delete the redundant definition"
          : "move the override after the import that redefines it, or delete it",
        scores: {
          severity: severityScore(severity),
          confidence,
          agent_risk: round(same ? 0.25 : 0.5),
        },
        suggested_actions: [
          {
            kind: same ? "remove_redundant_definition" : "reorder_or_remove_override",
            description: same
              ? "Delete this definition; the later one is identical and is the one in effect."
              : "Decide which value is intended. If this one, define it after the import that " +
                "overrides it; if not, delete it so the file stops implying a value it does not set.",
            risk: "low",
          },
        ],
      });
    }
    resolveDiscriminators(findings);
    return findings;
  },
};

export const lessDetectors: LanguageLessDetector[] = [overriddenVariableDetector];
