import type { Detector } from "../detector.js";
import type { Finding } from "../finding.js";
import { isTestFile } from "../util/test-files.js";

const NEGATIVE_NAME = /^(?:no|not|disable|disabled|skip|without)[A-Z_]/;

export const negativeFlagMazeDetector: Detector = {
  id: "negative_flag_maze",
  name: "Negative Flag Maze",
  description: "Flags conditionals that combine multiple negative flags.",
  whyItMatters:
    "Predicates built from multiple negative flags are easy to invert by " +
    "accident. Agents simplifying or extending such conditions frequently " +
    "flip the meaning, especially when the flag name and the surrounding " +
    "logic disagree.",

  run(ctx) {
    if (isTestFile(ctx.file)) return [];

    const findings: Finding[] = [];
    for (const condition of extractConditions(ctx.source)) {
      const allSignals = Array.from(new Set(
        identifiersIn(condition.text).filter((name) => NEGATIVE_NAME.test(name)),
      )).sort();
      if (allSignals.length < 2) continue;

      findings.push({
        id: "",
        type: "negative_flag_maze",
        charge: "Negative Flag Maze",
        severity: "low",
        confidence: 0.72,
        file: ctx.file,
        lines: [condition.line, condition.line],
        summary:
          `Conditional combines ${allSignals.length} negative flags. Double-negative logic is easy to invert during maintenance.`,
        evidence: [
          `negative flags: ${allSignals.join(", ")}`,
          `condition: ${truncate(condition.text.replace(/\s+/g, " "), 100)}`,
        ],
        effort: "small",
        fix_shape: "invert flags to read positively; consolidate combined states",
        scores: {
          severity: 0.25,
          confidence: 0.72,
          agent_risk: Math.min(0.5 + allSignals.length * 0.08, 0.75),
        },
        suggested_actions: [
          {
            kind: "rename_or_simplify_flags",
            description:
              "Prefer positive flag names or extract the predicate into a named helper before extending this condition.",
            risk: "low",
          },
        ],
      });
    }

    return findings.slice(0, 5);
  },
};

interface Condition {
  text: string;
  line: number;
}

function extractConditions(source: string): Condition[] {
  const conditions: Condition[] = [];
  for (const match of source.matchAll(/\b(?:if|while)\s*\(/g)) {
    const start = match.index ?? 0;
    const open = source.indexOf("(", start);
    const close = findMatchingParen(source, open);
    if (open === -1 || close === -1) continue;
    conditions.push({
      text: source.slice(open + 1, close),
      line: lineOfOffset(source, start),
    });
  }
  return conditions;
}

function findMatchingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function identifiersIn(text: string): string[] {
  return Array.from(text.matchAll(/\b[A-Za-z_$][\w$]*\b/g), (match) => match[0]);
}

function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}
