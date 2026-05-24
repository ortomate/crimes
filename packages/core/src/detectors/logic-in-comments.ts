import type { LanguageJsDetector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";
import { extractComments } from "../petty/comments.js";

const RULE_TERMS = [
  "must",
  "never",
  "always",
  "only",
  "required",
  "forbidden",
  "unless",
  "except",
  "until",
  "after",
  "before",
  "do not",
  "don't",
  "cannot",
  "can't",
  "important",
];

const DOMAIN_TERMS = [
  "admin",
  "owner",
  "role",
  "plan",
  "tier",
  "billing",
  "payment",
  "refund",
  "timezone",
  "utc",
  "cache",
  "retry",
  "idempotent",
  "permission",
  "auth",
];

const TODO_MARKER_PATTERN = new RegExp(
  ["TO" + "DO", "FIX" + "ME", "X" + "XX", "HA" + "CK"].join("|"),
  "i",
);

export const logicInCommentsDetector: LanguageJsDetector = {
  id: "logic_in_comments",
  name: "Logic in Comments",
  description: "Flags comments that appear to carry business rules or safety constraints.",
  whyItMatters:
    "Rules that live only in prose are not enforceable. Anyone (or any " +
    "agent) editing the file can drop the constraint without the type " +
    "system, tests, or runtime guards catching the change. Encoding the " +
    "rule in code is the only way to make it survive.",

  pack: "language-js",
  run(ctx) {
    const sourceLines = ctx.source.split(/\r?\n/);
    const findings: Finding[] = [];

    for (const comment of extractComments(ctx.source)) {
      if (comment.raw.trimStart().startsWith("/**")) continue;
      if (TODO_MARKER_PATTERN.test(comment.text)) continue;

      const commentText = comment.text.toLowerCase();
      const ruleTerms = RULE_TERMS.filter((term) => commentText.includes(term));
      const domainTerms = DOMAIN_TERMS.filter((term) => commentText.includes(term));
      if (ruleTerms.length < 2 || domainTerms.length < 1) continue;

      const nearby = nearbySource(sourceLines, comment.endLine, 16).toLowerCase();
      const missingTerms = domainTerms.filter((term) => !nearby.includes(term));
      if (missingTerms.length === 0) continue;

      const severity = pickSeverity(ctx.file, ruleTerms.length, domainTerms.length);
      const confidence = round(Math.min(0.54 + ruleTerms.length * 0.04 + missingTerms.length * 0.03, 0.76));
      const quoted = truncate(comment.text.replace(/\s+/g, " ").trim(), 110);

      findings.push({
        id: "",
        type: "logic_in_comments",
        charge: "Logic in the Alibi",
        severity,
        confidence,
        file: ctx.file,
        lines: [comment.startLine, comment.endLine],
        summary:
          `Comment appears to carry a rule that nearby code does not obviously encode. ` +
          `Hidden prose rules are easy for agents and new maintainers to miss.`,
        evidence: [
          `comment says: "${quoted}"`,
          `rule terms: ${ruleTerms.slice(0, 5).join(", ")}`,
          `domain terms not found nearby: ${missingTerms.slice(0, 5).join(", ")}`,
        ],
        effort: "small",
        fix_shape: "lift the prose rule to an assert / type / test / config check",
        scores: {
          severity: severityScore(severity),
          confidence,
          agent_risk: round(Math.min(0.55 + ruleTerms.length * 0.05 + missingTerms.length * 0.03, 0.8)),
        },
        suggested_actions: [
          {
            kind: "encode_comment_rule",
            description:
              "Move the rule into a named guard, type, config value, or test; keep comments for rationale.",
            risk: "low",
          },
        ],
      });
    }

    return findings.slice(0, 5);
  },
};

function nearbySource(lines: string[], endLine: number, window: number): string {
  return lines.slice(endLine, Math.min(lines.length, endLine + window)).join("\n");
}

function pickSeverity(file: string, ruleCount: number, domainCount: number): Severity {
  if (/\/routes?\//.test(file) || ruleCount + domainCount >= 6) return "medium";
  return "low";
}

function severityScore(severity: Severity): number {
  return severity === "medium" ? 0.5 : 0.3;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
