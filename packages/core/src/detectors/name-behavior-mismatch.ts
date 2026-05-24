import type { LanguageJsDetector } from "../detector.js";
import type { Finding, Severity } from "../finding.js";

const PURE_PREFIXES = [
  "get",
  "find",
  "read",
  "select",
  "is",
  "has",
  "can",
  "should",
  "build",
  "format",
  "render",
  "calculate",
  "derive",
  "parse",
];

const DISCLOSES_MUTATION = /^(getOrCreate|findOrCreate|create|save|update|delete|remove|send|emit|publish|track|charge|refund|write|set)/;
const SIDE_EFFECT_CALL = /\b(?:save|create|update|delete|remove|insert|send|emit|publish|track|charge|refund|write|set|mutate|dispatch)[A-Z_]\w*\s*\(/g;
const STRONG_SIDE_EFFECT = /\b(?:charge|refund|delete|remove|sendEmail|sendInvoice|publish|emit|track)[A-Z_]\w*\s*\(/g;
const API_SIDE_EFFECT = /\b(?:fetch|localStorage\.setItem|sessionStorage\.setItem|writeFile|appendFile|unlink|mkdir|rm|rmdir)\s*\(/g;
const ASSIGNMENT = /(?:^|[^=!<>])=(?!=)|\+\+|--/g;

export const nameBehaviorMismatchDetector: LanguageJsDetector = {
  id: "name_behavior_mismatch",
  name: "Name / Behaviour Mismatch",
  description: "Flags functions whose names imply safe reads or calculations while their bodies perform side effects.",
  whyItMatters:
    "A function whose name reads as a pure getter but does I/O, or a " +
    "setter that fires side effects, surprises every caller. Agents triage " +
    "code by names — a safe-sounding name often makes them call something " +
    "dangerous from a hot loop.",

  pack: "language-js",
  run(ctx) {
    const lines = ctx.source.split(/\r?\n/);
    const findings: Finding[] = [];

    for (const fn of ctx.parsed.functions) {
      const name = fn.name;
      if (!name || !looksPure(name) || DISCLOSES_MUTATION.test(name)) continue;
      if (isTestFile(ctx.file)) continue;

      const body = lines.slice(fn.startLine - 1, fn.endLine).join("\n");
      const score = scoreBody(body);
      if (!score) continue;

      const severity = pickSeverity(body);
      const confidence = round(Math.min(0.62 + score.signals.length * 0.06, 0.86));
      findings.push({
        id: "",
        type: "name_behavior_mismatch",
        charge: "False Identity",
        severity,
        confidence,
        file: ctx.file,
        symbol: name,
        lines: [fn.startLine, fn.endLine],
        summary:
          `${name} has a safe-sounding name but appears to perform side effects. ` +
          `Misleading names make edits riskier because callers may treat the function as pure.`,
        evidence: [
          `name prefix suggests ${prefixMeaning(name)}`,
          `side-effect-like calls: ${score.calls.slice(0, 5).join(", ")}`,
          `${score.signals.length} side-effect signal${score.signals.length === 1 ? "" : "s"} in the function body`,
        ],
        effort: "small",
        fix_shape: "rename to match behaviour, or change the body to match the name",
        scores: {
          severity: severityScore(severity),
          confidence,
          agent_risk: round(Math.min(0.6 + score.signals.length * 0.06, 0.85)),
        },
        suggested_actions: [
          {
            kind: "rename_or_extract_side_effect",
            description:
              "Rename the function to disclose the side effect, or extract the pure calculation/read from the mutation.",
            risk: "low",
          },
        ],
      });
    }

    return findings.slice(0, 5);
  },
};

interface BodyScore {
  calls: string[];
  signals: string[];
}

function looksPure(name: string): boolean {
  const lower = `${name[0]!.toLowerCase()}${name.slice(1)}`;
  return PURE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix));
}

function scoreBody(body: string): BodyScore | undefined {
  const calls = [
    ...matches(body, SIDE_EFFECT_CALL),
    ...matches(body, STRONG_SIDE_EFFECT),
    ...matches(body, API_SIDE_EFFECT),
  ];
  const uniqueCalls = Array.from(new Set(calls.map((call) => call.replace(/\s*\($/, ""))));
  const signals = [...uniqueCalls];

  const assignmentCount = matches(body, ASSIGNMENT).length;
  if (assignmentCount >= 2) signals.push(`${assignmentCount} assignments`);
  if (/\bawait\b/.test(body) && uniqueCalls.length > 0) signals.push("await with side-effect-like call");

  const hasStrongSideEffect = matches(body, STRONG_SIDE_EFFECT).length > 0;
  if (signals.length < 2 && !hasStrongSideEffect) return undefined;
  if (uniqueCalls.length === 0) return undefined;

  return { calls: uniqueCalls, signals };
}

function matches(text: string, pattern: RegExp): string[] {
  return text.match(pattern) ?? [];
}

function pickSeverity(body: string): Severity {
  return /\bexport\b/.test(body) ? "medium" : "low";
}

function severityScore(severity: Severity): number {
  return severity === "medium" ? 0.55 : 0.35;
}

function prefixMeaning(name: string): string {
  const lower = `${name[0]!.toLowerCase()}${name.slice(1)}`;
  const prefix = PURE_PREFIXES.find((p) => lower === p || lower.startsWith(p));
  if (prefix === "is" || prefix === "has" || prefix === "can" || prefix === "should") {
    return "a predicate";
  }
  if (prefix === "build" || prefix === "format" || prefix === "calculate" || prefix === "derive" || prefix === "parse") {
    return "a pure transformation";
  }
  return "a read";
}

function isTestFile(file: string): boolean {
  return /\.test\.|\.spec\.|__tests__\//.test(file);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
